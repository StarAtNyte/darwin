// DARWIN dashboard: a Muller plot of founding dynasties, a specimen drawer, field notes and selection pressures.
// Streams /stream (SSE) and steers the run through /api/*. No dependencies.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SEED = 1_000_000;
const KINDS = ["arith", "extract", "classify", "reason"];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ---------- tokens (every colour and face comes from tokens.css) ----------
const T = {};
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).replace(/\/\*.*?\*\//g, "").trim();
  for (const k of ["paper", "paper-2", "paper-3", "ink", "ink-2", "muted", "rule", "rule-soft", "accent", "error"]) T[k] = v(`--color-${k}`);
  T.body = v("--font-body");
  T.mono = v("--font-mono");
  T.pigments = [];
  for (let i = 1; v(`--pigment-${i}`); i++) T.pigments.push(v(`--pigment-${i}`));
  T.other = v("--pigment-other") || T.muted;
  T.otherHatch = v("--pigment-other-hatch") || T.muted;
  T.ai = v("--color-ai") || T.ink;
  T.deep = [];
  for (let i = 1; v(`--pigment-deep-${i}`); i++) T.deep.push(v(`--pigment-deep-${i}`));
}

// ---------- state ----------
const S = {
  state: null,
  metrics: [],
  snap: null,
  agents: new Map(), // id -> latest snapshot agent
  genomes: new Map(), // id -> full genome from "born" events
  founders: new Map(), // founder -> { idx, first }
  hue: new Map(), // founder -> pigment slot, fixed once the family gets a band
  derived: [], // per metrics index: { ended: [founders], deaths, blocked, leaked }
  notes: new Map(), // tick -> group
  designs: [], // forks whose child genome an AI model chose: { tick, parent, child, rationale, model }
  shockMarks: [], // instant shocks { tick, kind }
  exportInfo: null,
  exportTick: -1,
  selected: null,
  mode: "n",
  hover: null,
  status: "loading", // loading | live | disconnected
  tickError: null,
  offRecord: null, // first round a child was not replayed from the run's recording (a shock moved the run off it)
};

const short = (id) => (id ? String(id).replace(/\.darwin\.testnet$/, "") : "");
const credits = (micro, d = 2) => (micro / SEED).toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (n, d = 0) => Number(n).toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];
const word = (n) => (n <= 20 ? WORDS[n] : fmt(n));
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const plural = (n, a, b = a + "s") => (n === 1 ? a : b);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const idHtml = (id) => `<span class="id">${esc(short(id))}</span>`;
// A model's reason as recorded (stray markup removed), with code names shown in plain words (each marked, raw word
// on hover) and a reason the old 160-character cap cut short ending at a whole word plus "…". The full raw text is
// in the quote's title. quoteHtml lives in summary.js so the test can load it.
const quote = (r) => {
  const q = quoteHtml(r);
  const note = q.clipped ? "Recorded runs kept only the first 160 characters of each reason. " : "";
  return q.mapped || q.clipped ? `<span title="${esc(`${note}Claude’s words: “${q.raw}”`)}">“${q.html}”</span>` : `“${q.html}”`;
};
const list = (xs) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

// Small dynasties share one thin, labelled band on the plot (see layout): the TOP_BANDS largest families now, plus up
// to EXTRA_BANDS that were larger earlier, get colours of their own.
const OTHER = "__other";
const TOP_BANDS = 6;
// The opening, while the founders are still a near-equal field, is squeezed into at most this share of the width.
const OPENING_SHARE = 0.14;
const EXTRA_BANDS = 2;
// While many founders are still near-equal the pooled band can hold most agents. It is drawn no taller than
// OTHER_DRAW of the plot (see layout's compressed scale), and the band's label and tooltip give its real share.
const OTHER_DRAW = 0.11;
const BAND_POW = 0.65;
const LEAD_SHARE_EARLY = 0.25;

function colourOf(f, deep = false) {
  if (f === OTHER) return T.other;
  const rec = S.founders.get(f);
  if (!rec || !T.pigments.length) return T.muted;
  const slot = S.hue.get(f) ?? rec.idx;
  if (deep && T.deep.length) return T.deep[slot % T.pigments.length % T.deep.length];
  return T.pigments[slot % T.pigments.length];
}
// A family keeps the pigment it was first given; a newly named family takes a pigment no other named family uses.
function assignHues(named) {
  const used = new Set(named.filter((f) => S.hue.has(f)).map((f) => S.hue.get(f) % T.pigments.length));
  for (const f of named) {
    if (S.hue.has(f)) continue;
    let slot = 0;
    while (used.has(slot) && slot < T.pigments.length) slot++;
    if (slot === T.pigments.length) slot = (S.founders.get(f)?.idx ?? 0) % T.pigments.length;
    used.add(slot);
    S.hue.set(f, slot);
  }
}

// The leading dynasty at the latest tick, once it holds at least this share, is drawn in its deep pigment.
const LEAD_SHARE = 0.4;
// Every count and the leader's name on the page come from DarwinSummary.summarize (summary.js) of the latest round.
const { summarize, statusLine, leadSentence, quoteHtml } = window.DarwinSummary;
let viewCache = null;
function view() {
  const m = S.metrics[S.metrics.length - 1];
  if (!m) return null;
  if (viewCache?.m !== m) viewCache = { m, v: summarize(m) };
  return viewCache.v;
}
function leader() {
  const v = view();
  return v && v.leader && v.population ? { f: v.leader, share: v.leaderShare, n: v.leaderN, total: v.population, tied: v.tied } : null;
}

// ---------- ingest ----------
function addFounder(f, tick) {
  if (!S.founders.has(f)) S.founders.set(f, { idx: S.founders.size, first: tick });
}

function ingestMetrics(m) {
  if (!m || typeof m.tick !== "number") return false;
  const last = S.metrics[S.metrics.length - 1];
  if (last && m.tick <= last.tick) return false;
  const keys = Object.keys(m.lineages || {});
  const fresh = keys.filter((k) => !S.founders.has(k)).sort((a, b) => (parseInt(short(a).replace(/\D/g, "")) || 0) - (parseInt(short(b).replace(/\D/g, "")) || 0));
  for (const k of fresh) addFounder(k, m.tick);
  const ended = last ? Object.keys(last.lineages || {}).filter((k) => !(k in (m.lineages || {}))) : [];
  S.derived.push({
    ended,
    deaths: last ? m.deaths - last.deaths : 0,
    blocked: last ? m.rogueBlocked - last.rogueBlocked : m.rogueBlocked,
    leaked: last ? m.rogueLeaked - last.rogueLeaked : m.rogueLeaked,
  });
  S.metrics.push(m);
  return true;
}

function ingestSnapshot(snap) {
  S.snap = snap;
  // The server sends state only on changes; keep the tick in the status line current from each snapshot.
  if (S.state && snap.tick > S.state.tick) S.state.tick = snap.tick;
  for (const a of snap.agents) S.agents.set(a.id, a);
  ingestMetrics(snap.metrics);
}

function noteGroup(tick) {
  let g = S.notes.get(tick);
  if (!g) {
    g = { tick, forks: [], kills: [], subs: [], guard: [], allow: [], shocks: [], rules: [], arrivals: [], rogues: [] };
    S.notes.set(tick, g);
    if (S.notes.size > 160) S.notes.delete(Math.min(...S.notes.keys()));
  }
  return g;
}

function ingestEvent(e) {
  if (e.event === "born") {
    S.genomes.set(e.agent, e.genome);
    if (e.parent && e.role === "parametric" && e.mutation && e.mutation !== "cache" && S.state?.mutation?.recording && (S.offRecord === null || e.tick < S.offRecord)) S.offRecord = e.tick;
    if (e.rationale && e.parent) {
      S.designs.push({ tick: e.tick, parent: e.parent, child: e.agent, founder: e.founder, rationale: e.rationale, model: e.model, recorded: e.mutation === "cache", live: e.mutation === "llm" });
      if (S.designs.length > 300) S.designs.shift();
    }
    if (e.tick > 0 && !e.parent) {
      if (e.role === "rogue") noteGroup(e.tick).rogues.push(e.agent);
      else if (e.role === "parametric") noteGroup(e.tick).arrivals.push(e.agent);
    }
    return;
  }
  if (e.tick === undefined) return;
  const g = noteGroup(e.tick);
  if (e.event === "fork") g.forks.push(e);
  else if (e.event === "kill") g.kills.push(e);
  else if (e.event === "subcontract") g.subs.push(e);
  else if (e.event === "guard_block") g.guard.push(e);
  else if (e.event === "guard_allow_rogue") g.allow.push(e);
  else if (e.event === "shock") {
    g.shocks.push(e);
    if (e.shock === "rogue" || e.shock === "immigration") S.shockMarks.push({ tick: e.tick, kind: e.shock });
  } else if (e.event === "rules") g.rules.push(e);
}

function clearAll() {
  S.metrics = [];
  S.derived = [];
  S.snap = null;
  S.agents.clear();
  S.genomes.clear();
  S.founders.clear();
  S.hue.clear();
  S.offRecord = null;
  S.notes.clear();
  S.designs = [];
  S.shockMarks = [];
  S.exportInfo = null;
  S.exportTick = -1;
  S.hover = null;
  S.lastShock = null;
  narrReset();
}

// ---------- network ----------
let es = null;
let retryTimer = 0;

async function loadHistory() {
  const r = await fetch("/history", { cache: "no-store" });
  if (!r.ok) throw new Error(`history ${r.status}`);
  const h = await r.json();
  clearAll();
  S.state = h.state;
  for (const m of h.metrics) ingestMetrics(m);
  for (const e of h.events) ingestEvent(e);
  try {
    const sr = await fetch("/snapshot", { cache: "no-store" });
    if (sr.ok) {
      const snap = await sr.json();
      S.snap = snap;
      for (const a of snap.agents) S.agents.set(a.id, a);
    }
  } catch {}
  S.status = "live";
  schedule("all");
  renderLive();
}

// The stream is live while anything arrives on it; the server sends a ping every 15 s even when the run is quiet
// (paused, finished), so a proxy never sees an idle connection. Only a stream silent for STALE_MS counts as lost, and
// then the client reconnects with backoff. A lost connection shows a small "Reconnecting…" in the status line, never a banner.
const STALE_MS = 8000, DEAD_MS = 40000;
let lastMsg = 0, backoff = 1000, historyBusy = false;
function heard() {
  lastMsg = Date.now();
  backoff = 1000;
  if (S.status === "disconnected") {
    S.status = "live";
    schedule("chrome");
    // Backfill anything missed while the stream was down.
    if (!historyBusy) { historyBusy = true; loadHistory().catch(() => {}).finally(() => (historyBusy = false)); }
  }
}
function stale() {
  if (S.status === "disconnected") return;
  S.status = "disconnected";
  schedule("chrome");
}
function reconnectSoon() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}
setInterval(() => {
  if (!es || !lastMsg) return;
  const quiet = Date.now() - lastMsg;
  if (quiet > STALE_MS && es.readyState !== EventSource.OPEN) stale();
  if (quiet > DEAD_MS) { stale(); es.close(); reconnectSoon(); lastMsg = Date.now(); }
}, 2000);

function connect() {
  clearTimeout(retryTimer);
  es?.close();
  es = new EventSource("/stream");
  lastMsg ||= Date.now();
  es.addEventListener("open", heard);
  es.addEventListener("ping", heard);
  es.addEventListener("state", (e) => {
    heard();
    const st = JSON.parse(e.data);
    const otherRun = S.state?.run && st.run && st.run !== S.state.run;
    S.state = st;
    schedule("chrome");
    // The stream reconnected to a different run (the server restarted or redeployed): the chart and notes hold the
    // old run, so reload them rather than show one run's counter over another's history.
    if (otherRun && !historyBusy) { historyBusy = true; loadHistory().catch(() => {}).finally(() => (historyBusy = false)); }
  });
  es.addEventListener("snapshot", (e) => {
    heard();
    ingestSnapshot(JSON.parse(e.data));
    if (S.status === "loading") S.status = "live";
    schedule("all");
  });
  es.addEventListener("chain", (e) => {
    heard();
    const t = JSON.parse(e.data);
    S.live = { ...(S.live ?? { enabled: true, intervalSec: 45 }), recent: [t, ...(S.live?.recent ?? [])].slice(0, 5) };
    renderLive();
  });
  es.addEventListener("ev", (e) => {
    heard();
    ingestEvent(JSON.parse(e.data));
    schedule("notes");
  });
  es.addEventListener("reset", async (e) => {
    heard();
    S.state = JSON.parse(e.data);
    S.selected = null;
    clearAll();
    schedule("all");
    renderLive();
    try { await loadHistory(); } catch {}
  });
  es.addEventListener("error", (e) => {
    if (e.data) {
      // A round failed on the server; the server paused the run.
      try { S.tickError = JSON.parse(e.data).message; } catch { S.tickError = String(e.data); }
      schedule("chrome");
      return;
    }
    // A transient drop: the browser retries on its own (readyState CONNECTING). The watchdog above decides
    // whether the data is stale. A closed stream (the server answered with an error) is retried here, with backoff.
    if (es.readyState === EventSource.CLOSED) reconnectSoon();
  });
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(data.error || `The server answered ${r.status}.`), { status: r.status, data });
  return data;
}

async function control(action, value) {
  try {
    const st = await post("/api/control", value === undefined ? { action } : { action, value });
    S.state = st;
    schedule("chrome");
  } catch (err) {
    setStatusError(err.message);
  }
}

async function refreshExport(force) {
  const tick = S.state?.tick ?? 0;
  if (!force && tick - S.exportTick < 20) return;
  S.exportTick = tick;
  fetch("/api/state", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((st) => { if (st && S.state && st.seed === S.state.seed) { S.state = st; schedule("chrome"); } }).catch(() => {});
  try {
    const r = await fetch("/api/export/genome", { cache: "no-store" });
    const j = await r.json();
    S.exportInfo = r.ok ? j : { error: j.error || "No champion yet." };
  } catch {
    S.exportInfo = { error: "The server did not answer." };
  }
  schedule("specimen");
  renderExportPreview();
}

// ---------- render scheduling ----------
const dirty = new Set();
let raf = 0;
function schedule(what) {
  if (what === "all") ["chrome", "plot", "specimen", "notes", "figs"].forEach((w) => dirty.add(w));
  else dirty.add(what);
  if (!raf) raf = requestAnimationFrame(flush);
}
function flush() {
  raf = 0;
  if (dirty.has("chrome")) renderChrome();
  if (dirty.has("plot")) drawPlot();
  if (dirty.has("specimen")) renderSpecimen();
  if (dirty.has("notes")) renderNotes();
  if (dirty.has("plot") || dirty.has("notes") || dirty.has("chrome")) renderAI();
  if (dirty.has("plot") || dirty.has("chrome")) renderTake();
  if (dirty.has("figs")) { renderFigs(); renderShockOutcome(); }
  if (dirty.has("plot") && S.metrics.length) refreshExport(false);
  dirty.clear();
  if (tour.open) placeTour();
}

// ---------- chrome: status, transport, notices ----------
const SPEED_WORDS = ["slow", "normal", "fast", "fastest"];
function roundsPerSec(st) {
  const ms = st?.speeds?.[st.speed];
  if (!ms) return "";
  const r = 1000 / ms;
  return r < 1.5 ? "about one round a second" : `about ${fmt(r)} rounds a second`;
}
let statusErr = null;
let statusErrTimer = 0;
function setStatusError(msg) {
  statusErr = msg;
  clearTimeout(statusErrTimer);
  statusErrTimer = setTimeout(() => { statusErr = null; renderChrome(); }, 5000);
  renderChrome();
}

// Shocks on a shared run: one at a time across every visitor. The server says how long until the next.
let seenState = null, shockReadyAt = 0, shockWaitTimer = 0;
function renderShockWait() {
  clearTimeout(shockWaitTimer);
  const left = Math.ceil((shockReadyAt - Date.now()) / 1000);
  const waiting = left > 0;
  $$("[data-shock]").forEach((b) => (b.disabled = waiting));
  $$(".shock-wait").forEach((p) => {
    p.hidden = !waiting;
    if (waiting) p.textContent = `Next shock in ${left} s`;
  });
  if (waiting) shockWaitTimer = setTimeout(renderShockWait, 1000);
}

// The server sends seconds left when a finished run will restart; turn that into a deadline once per state
// object, then tick the notice every second so the wait reads as a countdown, not a frozen page.
const restartDeadline = new WeakMap();
function restartLeft(st) {
  if (st.restartInSec == null) return "on its own in a moment";
  if (!restartDeadline.has(st)) restartDeadline.set(st, Date.now() + st.restartInSec * 1000);
  const sec = Math.ceil((restartDeadline.get(st) - Date.now()) / 1000);
  return sec > 0 ? `in ${sec} s` : "now";
}
setInterval(() => { if (S.state?.finished && S.state?.restartInSec != null) renderChrome(); }, 1000);

function renderChrome() {
  const st = S.state;
  const status = $("#status");
  const toggle = $("#toggle");
  const step = $("#step");
  const notice = $("#notice");
  const noticeText = $("#notice-text");
  const noticeAction = $("#notice-action");

  if (S.status === "disconnected") {
    status.hidden = false;
    status.textContent = "Reconnecting…";
    status.dataset.kind = "conn";
    toggle.disabled = true;
    step.hidden = true;
    $$("#speed input").forEach((i) => (i.disabled = true));
    $("#speed-select").disabled = true;
    return;
  }
  if (!st) return;
  delete status.dataset.kind;
  $$("#speed input").forEach((i) => {
    i.disabled = false;
    i.checked = Number(i.value) === st.speed;
  });
  const sel = $("#speed-select");
  sel.disabled = false;
  if (st.speed in SPEED_WORDS) sel.value = String(st.speed);

  const parts = [];
  // The tick lives in the big counter; the status line says only what the run is doing. A finished run says so in the banner.
  // One line: what a round is, and how fast they pass.
  if (!st.finished) parts.push(st.paused ? "Each round agents bid for tasks and pay rent. Paused" : `Each round agents bid for tasks and pay rent, ${roundsPerSec(st)}`);
  status.title = `Seed ${st.seed}`;
  const shocks = Object.entries(st.shocks || {}).filter(([, end]) => end > st.tick);
  for (const [k, end] of shocks) parts.push(`<span class="shock">${k === "drought" ? "Drought" : "Plague"}, ${end - st.tick} ${plural(end - st.tick, "round")} left</span>`);
  let html = parts.length ? parts.join(". ") + "." : "";
  if (statusErr) html += ` <span class="shock">${esc(statusErr)}</span>`;
  status.innerHTML = html;
  status.hidden = !html;
  // A shared public run takes shocks from visitors, nothing else: no transport, no rules, no restart.
  const shared = !!st.publicMode;
  $("#shared").hidden = !shared;
  $('[data-sheet="rules"]').hidden = shared;
  $("#export-open").hidden = shared;
  if (shared && openSheet?.id === "sheet-export") closeSheet(true);
  renderTunnelMode();
  if (shared && openSheet?.id === "sheet-rules") closeSheet(true);
  if (st !== seenState) {
    seenState = st;
    shockReadyAt = Date.now() + (st.shockWaitSec || 0) * 1000;
    renderShockWait();
  }
  // Nothing left to pause or speed up once the run is over.
  $(".transport").hidden = st.finished || shared;
  $("#try").hidden = st.finished;

  toggle.disabled = st.finished;
  toggle.textContent = st.paused ? "Resume" : "Pause";
  toggle.setAttribute("aria-pressed", String(!st.paused));
  step.hidden = !st.paused || st.finished;

  const llm = st.rules?.mutation === "llm" || st.rules?.mutation === "mixed";
  const who = operatorName();
  const loop = "Agents bid for tasks, earn, have children that inherit their strategy, or go broke and die.";
  const tag = llm ? `${loop} ${who === "an AI model" ? "An AI model" : who} designs each child.` : `${loop} Each child is a small random change of its parent.`;
  if ($("#tagline").textContent !== tag) $("#tagline").textContent = tag;
  $("#tick").textContent = fmt(st.tick);
  $("#tick-of").textContent = `of ${fmt(st.maxTicks)} rounds`;

  if (S.tickError) {
    notice.hidden = false;
    noticeText.textContent = `A round failed on the server and the run paused: ${S.tickError}`;
    noticeAction.hidden = true;
  } else if (st.finished) {
    notice.hidden = false;
    noticeText.textContent = shared
      ? `The run finished at round ${fmt(st.tick)}.${st.autoRestart ? ` ${st.mutation?.recording ? "The next recorded run" : "A new run"} starts ${restartLeft(st)}.` : ""}`
      : `The run finished at round ${fmt(st.tick)}. Export the champion, or start a new run with the same rules.`;
    noticeAction.hidden = shared;
  } else if (st.takeover && st.tick < (st.startRound || 0) + 150) {
    // The last run was decided (one family held the line), so the server started a new one: say so.
    const t = st.takeover;
    notice.hidden = false;
    noticeText.textContent = `${short(t.founder)}’s family took over the last run at round ${fmt(t.since)} (${Math.round((st.epochRule?.share ?? 0.9) * 100)}% of agents for ${fmt(st.epochRule?.hold ?? 100)} rounds). A new run started.`;
    noticeAction.hidden = true;
  } else notice.hidden = true;

  if ($("#sheet-rules").hidden === false) syncRules(false);
}

// ---------- the Muller plot ----------
const plot = $("#plot");
const canvas = $("#muller");
const ctx = canvas.getContext("2d");
const shockCv = $("#shock-lane");
const guardCv = $("#guard-lane");
const notesCv = $("#notes-lane");
const aiCv = $("#ai-lane");
let geo = null; // last layout: { samples, bands: Map(f -> {y0, y1}), w, h, x(i) }

function sizeCanvas(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w, h };
}

function valueOf(lin, mode) {
  return mode === "wealth" ? Math.max(0, lin.wealth) : lin.n;
}

function layout(w) {
  const M = S.metrics;
  const n = M.length;
  const maxSamples = Math.max(30, Math.floor(w / 2));
  const step = Math.max(1, Math.ceil(n / maxSamples));
  const samples = [];
  for (let i = 0; i < n; i += step) samples.push(i);
  if (samples[samples.length - 1] !== n - 1) samples.push(n - 1);
  // Each family's peak share over the run so far, so families that mattered earlier can keep a colour.
  const earlyPeak = new Map();
  for (const mi of samples) {
    const lin = M[mi].lineages || {};
    let tot = 0;
    for (const f in lin) tot += valueOf(lin[f], S.mode);
    if (tot) for (const f in lin) earlyPeak.set(f, Math.max(earlyPeak.get(f) || 0, valueOf(lin[f], S.mode) / tot));
  }
  const totals = new Float64Array(samples.length);
  const founders = S.founders.size;
  // Where the founders stop being a flat field (one family at LEAD_SHARE_EARLY, or a quarter of them gone): the
  // x-axis squeezes the rounds before it.
  let divergeSi = -1;
  samples.forEach((mi, si) => {
    const lin = M[mi].lineages || {};
    let total = 0, top = 0;
    for (const f in lin) { const v = valueOf(lin[f], S.mode); total += v; top = Math.max(top, v); }
    totals[si] = total;
    if (divergeSi < 0 && total && (top / total >= LEAD_SHARE_EARLY || Object.keys(lin).length < founders * 0.75)) divergeSi = si;
  });
  // Which families get a band of their own: the TOP_BANDS largest now, plus up to EXTRA_BANDS that were larger
  // earlier (by peak share). Everyone else shares the thin pooled band. A named family is in colour for the whole run.
  const byIdx = (a, b) => (S.founders.get(a)?.idx ?? 0) - (S.founders.get(b)?.idx ?? 0);
  const lastLin = M[samples[samples.length - 1]].lineages || {};
  const nowTop = Object.keys(lastLin).sort((a, b) => valueOf(lastLin[b], S.mode) - valueOf(lastLin[a], S.mode) || byIdx(a, b)).slice(0, TOP_BANDS);
  const named = new Set(nowTop);
  for (const [f] of [...earlyPeak].sort((a, b) => b[1] - a[1] || byIdx(a[0], b[0]))) {
    if (named.size >= TOP_BANDS + EXTRA_BANDS) break;
    named.add(f);
  }
  const namedFrom = new Map([...named].map((f) => [f, 0]));
  const pooledAt = (f, si) => !(namedFrom.get(f) <= si);
  // Founders that never get a band of their own.
  const minor = new Set([...S.founders.keys()].filter((f) => !namedFrom.has(f)));
  const order = [...S.founders.entries()].filter(([f]) => namedFrom.has(f)).sort((a, b) => a[1].idx - b[1].idx).map(([f]) => f);
  assignHues([...namedFrom.keys()].sort((a, b) => namedFrom.get(a) - namedFrom.get(b) || (earlyPeak.get(b) || 0) - (earlyPeak.get(a) || 0)));
  const anyPooled = samples.some((mi, si) => Object.keys(M[mi].lineages || {}).some((f) => pooledAt(f, si)));
  if (anyPooled) order.push(OTHER);
  const bands = new Map(order.map((f) => [f, { y0: new Float32Array(samples.length), y1: new Float32Array(samples.length), first: -1, last: -1 }]));
  const others = new Float64Array(samples.length);
  const otherCount = new Uint16Array(samples.length);
  const otherShare = new Float32Array(samples.length);
  // Band heights use a compressed scale (share to the power BAND_POW): small families stay readable and a leader
  // with half the agents no longer flattens the rest into one slab, while a near-monoculture still fills the plot.
  // The pooled band is drawn at half its scaled share and never above OTHER_DRAW. Labels and tooltips give true shares.
  samples.forEach((mi, si) => {
    const lin = M[mi].lineages || {};
    const total = totals[si];
    for (const f in lin) if (pooledAt(f, si)) { others[si] += valueOf(lin[f], S.mode); otherCount[si]++; }
    otherShare[si] = total ? others[si] / total : 0;
    const wt = new Map();
    let named = 0;
    for (const f of order) {
      if (f === OTHER) continue;
      const v = lin[f] && !pooledAt(f, si) ? (Math.max(0, valueOf(lin[f], S.mode)) / (total || 1)) ** BAND_POW : 0;
      wt.set(f, v);
      named += v;
    }
    let pool = otherCount[si] ? otherShare[si] ** BAND_POW * 0.5 : 0;
    if (named > 0 && pool / (named + pool) > OTHER_DRAW) pool = (OTHER_DRAW / (1 - OTHER_DRAW)) * named;
    if (named === 0 && pool > 0) pool = 1;
    wt.set(OTHER, pool);
    const W = named + pool;
    let cum = 0;
    for (const f of order) {
      const b = bands.get(f);
      const here = f === OTHER ? otherCount[si] > 0 : !!lin[f] && !pooledAt(f, si);
      b.y0[si] = W ? cum / W : 0;
      cum += wt.get(f) || 0;
      b.y1[si] = W ? cum / W : 0;
      if (here) {
        if (b.first < 0) b.first = si;
        b.last = si;
      }
    }
  });
  // The x-axis spans the ticks seen so far, never the run's planned length. The opening, before any family pulls
  // ahead, takes at most OPENING_SHARE of the width; from the round the families diverge the scale is linear.
  const t0 = M[0]?.tick ?? 0;
  const t1 = Math.max(M[n - 1]?.tick ?? 1, t0 + 1);
  // A shared run opens at state.startRound: the rounds before it played in fast-forward on the server. They are
  // squeezed the same way, keeping at least the last 60 rounds on the linear scale while the run is young.
  let tD = divergeSi > 0 ? M[samples[divergeSi]].tick : null;
  const sr = S.state?.startRound || 0;
  const ffEnd = sr > t0 ? Math.min(sr, t1 - 60) : null;
  if (ffEnd !== null && ffEnd > t0 + 10 && (tD === null || tD < ffEnd)) tD = ffEnd;
  const natural = tD === null ? 1 : (tD - t0) / (t1 - t0);
  const squeezed = tD !== null && tD < t1 && natural > OPENING_SHARE;
  const fD = squeezed ? OPENING_SHARE : natural;
  const xt = (tick) => {
    if (!squeezed) return ((tick - t0) / (t1 - t0)) * w;
    return tick <= tD ? ((tick - t0) / (tD - t0)) * fD * w : (fD + ((tick - tD) / (t1 - tD)) * (1 - fD)) * w;
  };
  const x = (si) => xt(M[samples[si]].tick);
  return { samples, bands, order, minor, pooledAt, otherCount, otherShare, w, x, xt, t0, t1, tD: squeezed ? tD : null, fD };
}

function tracePath(c, b, from, to, x, h) {
  // Top edge forwards, bottom edge backwards, smoothed through midpoints.
  const pts = (arr, a, z, dir) => {
    const out = [];
    for (let i = a; dir > 0 ? i <= z : i >= z; i += dir) out.push([x(i), arr[i] * h]);
    return out;
  };
  const top = pts(b.y0, from, to, 1);
  const bot = pts(b.y1, to, from, -1);
  const smooth = (p, first) => {
    if (first) c.moveTo(p[0][0], p[0][1]);
    else c.lineTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
      c.quadraticCurveTo(p[i][0], p[i][1], mx, my);
    }
    const l = p[p.length - 1];
    c.lineTo(l[0], l[1]);
  };
  c.beginPath();
  smooth(top, true);
  smooth(bot, false);
  c.closePath();
}

function scars(g) {
  // Mass extinctions: many deaths, or several dynasties ending, within a short window.
  const M = S.metrics, D = S.derived, out = [];
  const W = 5;
  for (let i = 1; i < M.length; i++) {
    let deaths = 0, ended = 0;
    for (let j = i; j < Math.min(M.length, i + W); j++) { deaths += D[j].deaths; ended += D[j].ended.length; }
    const pop = M[i - 1].population || 1;
    if ((D[i].deaths > 0 || D[i].ended.length > 0) && (ended >= 4 || deaths >= Math.max(6, pop * 0.2))) {
      let survivor = null, best = -1;
      const last = M[Math.min(M.length - 1, i + W - 1)].lineages || {};
      for (const f in last) if (last[f].n > best) { best = last[f].n; survivor = f; }
      out.push({ tick: M[i].tick, deaths, ended, survivor });
      i += 15;
    }
  }
  return out;
}

// A monoculture: from some tick to now, one dynasty holds more than MONO_SHARE of the living agents at every
// tick, for at least MONO_MIN ticks. Read from the per-tick lineage counts the run reported.
const MONO_SHARE = 0.98, MONO_MIN = 50;
function monoculture() {
  const M = S.metrics;
  let f = null, start = -1, all = true;
  for (let i = M.length - 1; i >= 0; i--) {
    const lin = M[i].lineages || {};
    let total = 0, top = null, topN = 0;
    for (const k in lin) { total += lin[k].n; if (lin[k].n > topN) { topN = lin[k].n; top = k; } }
    if (!total || topN / total <= MONO_SHARE || (f && top !== f)) break;
    f = top;
    start = i;
    if (topN !== total) all = false;
  }
  if (start < 0 || M[M.length - 1].tick - M[start].tick < MONO_MIN) return null;
  // The tones inside its band start earlier, where it last took over half the living agents: the flat stretch
  // before the monoculture, with a newcomer or two at its edge, has the same inner structure to show.
  let from = start;
  while (from > 0) {
    const lin = M[from - 1].lineages || {};
    let total = 0;
    for (const k in lin) total += lin[k].n;
    if (!total || (lin[f]?.n || 0) / total <= 0.5) break;
    from--;
  }
  return { f, tick: M[start].tick, from: M[from].tick, all };
}

// Living members of one dynasty per tick, by generation, rebuilt from every agent's birth and death tick in
// the snapshot (an agent counts at tick t when born <= t < died, as the run's own lineage counts do).
let genCache = null;
function generationCounts(f, t0, t1) {
  const key = `${f}|${t0}|${t1}|${S.snap?.tick}`;
  if (genCache?.key === key) return genCache.v;
  const len = t1 - t0 + 1;
  const diff = new Map(); // generation -> Int32Array of +1/-1 steps
  for (const a of S.agents.values()) {
    if (a.founder !== f || a.role !== "parametric" || typeof a.born !== "number") continue;
    const s0 = Math.max(a.born, t0), e0 = Math.min(typeof a.died === "number" ? a.died : t1 + 1, t1 + 1);
    if (s0 >= e0) continue;
    if (!diff.has(a.generation)) diff.set(a.generation, new Int32Array(len + 1));
    const d = diff.get(a.generation);
    d[s0 - t0]++;
    d[e0 - t0]--;
  }
  const v = new Map();
  for (const [g, d] of diff) {
    const out = new Int32Array(len);
    let run = 0;
    for (let i = 0; i < len; i++) out[i] = run += d[i];
    v.set(g, out);
  }
  genCache = { key, v };
  return v;
}

// Inside a monoculture's band, sub-bands by generation bracket in tonal steps of the dynasty's colour: the
// oldest bracket lightest, the newest the deep pigment. Bracket width grows in fives to keep at most GEN_STEPS.
const GEN_STEPS = 6;
function drawGenerations(c, mono, b, x, h) {
  const { samples } = geo;
  const M = S.metrics;
  const tLast = M[M.length - 1].tick;
  const counts = generationCounts(mono.f, mono.from, tLast);
  if (!counts.size) return null;
  const sFrom = samples.findIndex((mi) => M[mi].tick >= mono.from);
  if (sFrom < 0) return null;
  const gens = [...counts.keys()].filter((g) => counts.get(g).some((v) => v > 0)).sort((a, b) => a - b);
  if (gens.length < 2) return null;
  let width = 5;
  const bucketOf = (g) => Math.floor(g / width);
  while (bucketOf(gens.at(-1)) - bucketOf(gens[0]) + 1 > GEN_STEPS) width += 5;
  const lo = bucketOf(gens[0]), K = bucketOf(gens.at(-1)) - lo + 1;
  // Per sample: members per bracket, oldest first.
  const per = samples.map((mi) => {
    const t = M[mi].tick;
    const row = new Float64Array(K);
    if (t < mono.from) return row;
    for (const g of gens) row[bucketOf(g) - lo] += counts.get(g)[t - mono.from];
    return row;
  });
  const deep = colourOf(mono.f, true), lite = colourOf(mono.f, false);
  c.save();
  c.globalAlpha = S.hover && S.hover !== mono.f ? 0.78 : 1;
  const last = samples.length - 1;
  const cum = new Float64Array(samples.length);
  const labels = [];
  for (let k = 0; k < K; k++) {
    const sub = { y0: new Float32Array(samples.length), y1: new Float32Array(samples.length) };
    let any = false;
    for (let si = sFrom; si <= last; si++) {
      const tot = per[si].reduce((a, v) => a + v, 0);
      const span = b.y1[si] - b.y0[si];
      sub.y0[si] = b.y0[si] + (tot ? cum[si] / tot : 0) * span;
      cum[si] += per[si][k];
      sub.y1[si] = b.y0[si] + (tot ? cum[si] / tot : 0) * span;
      if (per[si][k] > 0) any = true;
    }
    if (!any) continue;
    tracePath(c, sub, sFrom, last, x, h);
    c.fillStyle = deep;
    c.fill();
    if (k < K - 1) {
      c.save();
      c.globalAlpha *= 0.45 * (1 - k / (K - 1));
      c.fillStyle = lite;
      c.fill();
      c.restore();
    }
    c.lineWidth = 0.75;
    c.strokeStyle = T["paper-3"];
    c.stroke();
    const yh = (sub.y1[last] - sub.y0[last]) * h;
    const g0 = (lo + k) * width;
    labels.push({ y: ((sub.y0[last] + sub.y1[last]) / 2) * h, yh, text: `gen ${g0}–${g0 + width - 1}` });
  }
  // Each bracket tall enough to hold one is labelled at the right edge, in the plot's own face.
  c.font = `500 11px ${T.body}`;
  c.textBaseline = "middle";
  c.textAlign = "right";
  for (const l of labels) if (l.yh >= 16) { c.fillStyle = T.paper; c.fillText(l.text, geo.w - 6, l.y); }
  c.restore();
  return { f: mono.f, tick: mono.from, width, deep, lite };
}

// The pooled band of small families: a thin grey band with a fine diagonal hatch, so it reads as real agents taken
// together, not as missing data, with one line of label saying how many families and what share it holds.
let hatch = null;
function otherPattern(c) {
  const key = T.other + T.otherHatch;
  if (hatch?.key === key) return hatch.p;
  const t = document.createElement("canvas");
  t.width = t.height = 8;
  const g = t.getContext("2d");
  g.fillStyle = T.other;
  g.fillRect(0, 0, 8, 8);
  g.strokeStyle = T.otherHatch;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, 8);
  g.lineTo(8, 0);
  g.stroke();
  hatch = { key, p: c.createPattern(t, "repeat") };
  return hatch.p;
}
function labelOther(c, b, h, pin) {
  const { samples, x, otherCount, otherShare } = geo;
  // Label from the left edge (the newest rounds, on the right, carry the narration pin), at the latest sample
  // where the band is tall enough for one line of text.
  let si = samples.length - 1;
  const tall = (k) => (b.y1[k] - b.y0[k]) * h >= 15;
  while (si > 0 && (!otherCount[si] || !tall(si))) si--;
  const left = 6;
  if (!otherCount[si] || !tall(si)) return;
  const n = otherCount[si];
  const full = `Pooled: ${fmt(n)} small ${plural(n, "family", "families")}, ${Math.round(otherShare[si] * 100)}% of ${S.mode === "wealth" ? "the money" : "agents"} (band not to scale)`;
  const brief = `${fmt(n)} small ${plural(n, "family", "families")}, ${Math.round(otherShare[si] * 100)}%`;
  c.save();
  c.font = `600 12px ${T.body}`;
  const cy = ((b.y0[si] + b.y1[si]) / 2) * h;
  // Where the label may go: at the left edge, or, when the narration pin sits on that line, wholly to one side of
  // it (R px clear of its pulse). The full wording first, then the brief one.
  const R = 14;
  const hitsPin = pin && Math.abs(pin.y - cy) < 9 + R;
  let text = null, rx = left;
  for (const t of [full, brief]) {
    const tw = c.measureText(t).width + 12;
    const spots = !hitsPin ? [left] : [left, pin.x + R].filter((x0) => x0 + tw <= pin.x - R || x0 >= pin.x + R);
    const at = spots.find((x0) => x0 >= 0 && x0 + tw <= geo.w - 2);
    if (at !== undefined) { text = t; rx = at; break; }
  }
  if (!text) { c.restore(); return; }
  const tw = c.measureText(text).width + 12;
  c.fillStyle = T.paper;
  c.globalAlpha = 0.8;
  c.beginPath();
  c.roundRect(rx, cy - 9, tw, 18, 2);
  c.fill();
  c.globalAlpha = 1;
  c.textBaseline = "middle";
  c.fillStyle = T.ink;
  c.fillText(text, rx + 6, cy + 0.5);
  c.restore();
}

// Short display name for a model id (same rule as modelLabel in sim/src/mutator.ts). No id: an answer cached
// before models were recorded, which were all Claude's.
function modelName(id) {
  if (!id || /claude/i.test(id)) return "Claude";
  if (/mistral-large/i.test(id)) return "Mistral Large";
  const name = id.split("/").pop().replace(/:free$/, "").replace(/-(it|instruct|chat)$/i, "");
  return name.split(/[-_]/).map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
// Who designs children in this run: the live model if there is one, else whoever designed the latest child.
function operatorName() {
  const live = S.state?.mutation?.liveModel;
  if (live) return modelName(live);
  const last = latestDecision();
  return last ? modelName(last.model) : "an AI model";
}

// Children whose strategy an AI model chose, from every agent the run reported (dead ones included).
function claudeChildren() {
  const out = [];
  for (const a of S.agents.values()) if (a.origin === "llm" && typeof a.born === "number") out.push(a);
  return out;
}
function latestDecision() {
  let best = null;
  for (const a of S.agents.values()) if (a.origin === "llm" && a.rationale && typeof a.born === "number" && (!best || a.born > best.born || (a.born === best.born && a.id > best.id))) best = a;
  if (!best) {
    const d = S.designs.at(-1);
    return d ? { id: d.child, parent: d.parent, born: d.tick, founder: d.founder, rationale: d.rationale, model: d.model } : null;
  }
  return best;
}

// The decision shown above the chart. Each holds for AI_HOLD ms so it can be read, then the latest replaces it.
const AI_HOLD = 8000;
const AI = { cur: null, at: 0 };
function pickDecision() {
  const latest = latestDecision();
  if (!latest) { AI.cur = null; return null; }
  if (AI.cur && !S.agents.has(AI.cur.id) && !S.designs.some((d) => d.child === AI.cur.id)) AI.cur = null; // a new run
  const now = Date.now();
  if (!AI.cur || (latest.id !== AI.cur.id && now - AI.at >= AI_HOLD)) { AI.cur = latest; AI.at = now; }
  return AI.cur;
}
function renderAI() {
  const box = $("#ai"), st = S.state;
  if (!st || !S.metrics.length) { box.hidden = true; return; }
  const mode = st.rules?.mutation || "gaussian";
  const kids = claudeChildren().length;
  const cur = kids ? pickDecision() : null;
  box.hidden = false;
  box.dataset.mode = cur ? "llm" : "off";
  const set = (id, html) => { const el = $(id); if (el.innerHTML !== html) el.innerHTML = html; el.hidden = !html; };
  const rec = st.mutation?.recording;
  if (cur) {
    const was = box.dataset.cur;
    box.dataset.cur = cur.id;
    const who = modelName(cur.model);
    const d = S.designs.find((x) => x.child === cur.id);
    const recorded = !!rec && (d ? d.recorded : S.offRecord === null || cur.born < S.offRecord);
    const live = !!d?.live;
    $("#ai-tag").textContent = live ? `${who} decided · live` : recorded ? `${who} decided · recorded run` : `${who} decided`;
    box.dataset.live = String(live);
    set("#ai-what", `Round ${fmt(cur.born)}: ${idHtml(cur.parent)} got rich and forked ${idHtml(cur.id)}. ${esc(who)} chose the child’s strategy:`);
    set("#ai-why", quote(cur.rationale));
    // One line of provenance; the full breakdown is in the title.
    const born = [...S.agents.values()].filter((a) => a.parent && a.role === "parametric").length;
    const L = st.mutation?.live;
    const meta = live
      ? `Asked live during this run: ${esc(modelName(cur.model))} answered at round ${fmt(cur.born)}.${L ? ` Every ${nth(L.every)} fork asks live, at most one a minute; the rest replay a recorded run.` : ""}`
      : rec && S.offRecord === null
      ? `Replayed from a recorded ${esc(modelName(rec.model))} run (${fmt(rec.children)} children).${L ? ` Every ${nth(L.every)} fork asks ${esc(modelName(rec.model))} live, at most one a minute.` : ""}`
      : rec
        ? `Replayed from a recorded ${esc(modelName(rec.model))} run until a shock at round ${fmt(S.offRecord)}; later children ${st.mutation?.liveModel ? `ask ${esc(modelName(st.mutation.liveModel))} live` : "are random"}.`
        : `Designed by an AI model so far: ${fmt(kids)} of ${fmt(born)} children.`;
    set("#ai-meta", meta);
    $("#ai-meta").title = rec ? `${modelName(rec.model)} (${rec.model}) designed all ${rec.children} children of seed ${st.seed} ahead of time; each reason shown is the one it gave. No model is called during the replay. Purple marks under the chart show each design.` : "";
    if (was !== cur.id) { box.classList.remove("is-new"); void box.offsetWidth; box.classList.add("is-new"); }
    return;
  }
  delete box.dataset.cur;
  if (mode === "llm" || mode === "mixed") {
    const who = operatorName();
    $("#ai-tag").textContent = who === "an AI model" ? "AI model" : who;
    set("#ai-what", `Waiting for the first child. When an agent gets rich enough to fork, ${esc(who)} reads its record and the market, then chooses the child’s strategy and says why.`);
    set("#ai-why", "");
    set("#ai-meta", st.mutation?.fallback ? `${fmt(st.mutation.fallback)} ${plural(st.mutation.fallback, "child", "children")} fell back to random changes: no model available, or it was busy or slow.` : "");
  } else {
    $("#ai-tag").textContent = "Random mutation";
    set("#ai-what", "In this run each child copies its parent’s strategy with small random changes.");
    set("#ai-why", "");
    set("#ai-meta", st.publicMode ? "In an AI run, a language model chooses each child’s strategy and says why. <a href=\"https://github.com/StarAtNyte/darwin#an-ai-model-as-the-mutation-operator\" rel=\"noopener\">See how</a>." : "Open Rules and set Mutation to AI model: a language model then chooses each child’s strategy and says why.");
  }
}

function drawPlot() {
  const n = S.metrics.length;
  if (S.status === "loading") { plot.dataset.state = "loading"; return; }
  plot.dataset.state = n ? "full" : "empty";
  $("#plot-empty").hidden = n > 0;
  const { c, w, h } = sizeCanvas(canvas);
  c.clearRect(0, 0, w, h);
  const sl = sizeCanvas(shockCv), gl = sizeCanvas(guardCv);
  sl.c.clearRect(0, 0, sl.w, sl.h);
  gl.c.clearRect(0, 0, gl.w, gl.h);
  renderAxis(null);
  const hl = headline();
  $("#headline").textContent = hl;
  const line = statusLine(view());
  if ($("#statusline").textContent !== line) $("#statusline").textContent = line;
  announce(hl);
  renderCaption();
  if (!n) { geo = null; narrate(); return; }

  geo = layout(w);
  const { samples, bands, order, x, xt } = geo;
  const lastSi = samples.length - 1;

  // Bands. The leading dynasty, once it holds LEAD_SHARE, takes its deep pigment.
  const lead = leader();
  const deepF = lead && lead.share >= LEAD_SHARE && bands.has(lead.f) ? lead.f : null;
  const mono = monoculture();
  geo.gens = null;
  for (const f of order) {
    const b = bands.get(f);
    if (b.first < 0) continue;
    const from = Math.max(0, b.first - 1), to = Math.min(lastSi, b.last + 1);
    tracePath(c, b, from, to, x, h);
    c.fillStyle = f === OTHER ? otherPattern(c) : colourOf(f, f === deepF);
    c.globalAlpha = S.hover && S.hover !== f ? 0.78 : 1;
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = 0.75;
    c.strokeStyle = T["paper-3"];
    c.stroke();
    if (mono && f === mono.f && S.mode === "n") geo.gens = drawGenerations(c, mono, b, x, h);
    // Inside the leader, a few hairlines where its agents forked hardest: the texture of its growth. A leader
    // forks almost every tick, so marking every fork (even merged a few px apart) drew a dark fence across
    // the band. Only the busiest fork ticks are kept, at least FORK_GAP px apart and at most FORK_MAX in all.
    if (f === deepF) {
      const FORK_GAP = Math.max(80, w / 6), FORK_MAX = 5;
      const busy = [];
      for (const m of S.metrics) { const k = m.lineages?.[f]?.forks; if (k) busy.push({ x: Math.round(xt(m.tick)) + 0.5, k }); }
      busy.sort((p, q) => q.k - p.k);
      const marks = [];
      for (const q of busy) {
        if (marks.length >= FORK_MAX) break;
        if (marks.every((x0) => Math.abs(x0 - q.x) >= FORK_GAP)) marks.push(q.x);
      }
      c.save();
      tracePath(c, b, from, to, x, h);
      c.clip();
      c.strokeStyle = T.paper;
      c.globalAlpha = 0.14;
      c.lineWidth = 1;
      c.beginPath();
      for (const xx of marks) { c.moveTo(xx, 0); c.lineTo(xx, h); }
      c.stroke();
      c.restore();
    }
  }

  // The squeezed opening: a hairline where the scale turns linear, at the round the families diverged.
  if (geo.tD !== null) {
    const xx = Math.round(xt(geo.tD)) + 0.5;
    c.save();
    c.strokeStyle = T.paper;
    c.globalAlpha = 0.55;
    c.setLineDash([3, 3]);
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(xx, 0);
    c.lineTo(xx, h);
    c.stroke();
    c.restore();
  }

  // Shocked spans: a veil over the plot, and bars in the shock lane.
  const spans = shockSpans();
  for (const s of spans) {
    const x0 = xt(s.from), x1 = Math.max(x0 + 2, xt(s.to));
    c.fillStyle = T["paper-3"];
    c.globalAlpha = 0.32;
    c.fillRect(x0, 0, x1 - x0, h);
    c.globalAlpha = 1;
    sl.c.fillStyle = T["ink-2"];
    sl.c.globalAlpha = 0.85;
    sl.c.fillRect(x0, 0, x1 - x0, sl.h);
    sl.c.globalAlpha = 1;
    sl.c.font = `500 11px ${T.body}`;
    const label = s.kind;
    if (sl.c.measureText(label).width + 8 < x1 - x0) {
      sl.c.fillStyle = T.paper;
      sl.c.textBaseline = "middle";
      sl.c.fillText(label, x0 + 4, sl.h / 2 + 0.5);
    }
  }
  for (const m of S.shockMarks) {
    const xx = xt(m.tick);
    sl.c.fillStyle = T["ink-2"];
    sl.c.fillRect(xx - 1, 1, 2, sl.h - 2);
  }

  // Selected dynasty: outline in the signal colour.
  const sel = S.selected && bands.get(S.selected);
  if (sel && sel.first >= 0) {
    tracePath(c, sel, Math.max(0, sel.first - 1), Math.min(lastSi, sel.last + 1), x, h);
    c.lineWidth = 4;
    c.strokeStyle = T.paper;
    c.stroke();
    c.lineWidth = 2;
    c.strokeStyle = T.accent;
    c.stroke();
  }

  // Monoculture: a bar along the top edge from the tick one dynasty came to hold over MONO_SHARE of the agents.
  if (mono) {
    c.fillStyle = T.ink;
    c.fillRect(xt(mono.tick), 0, w - xt(mono.tick), 3);
  }

  // Mass extinction scars: a hairline each.
  const sc = scars();
  for (const s of sc) {
    const xx = Math.round(xt(s.tick)) + 0.5;
    c.strokeStyle = T.ink;
    c.globalAlpha = 0.85;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(xx, 0);
    c.lineTo(xx, h);
    c.stroke();
    c.globalAlpha = 1;
  }

  // Turning points, in their own lane above the plot so they never cover a band: stacked in up to three rows,
  // most telling first, each with a thin leader down to its tick. A note that cannot fit without overlapping
  // another note or a leader is dropped.
  drawNotes(turningPoints(sc), xt);

  // Labels go on last, so no hairline (the squeezed opening, a scar) ever runs through their text.
  // Direct labels: each named family's name and true share now, at the right edge of its band when it fits.
  {
    const lastLin = S.metrics[n - 1].lineages || {};
    let tot = 0;
    for (const f in lastLin) tot += valueOf(lastLin[f], S.mode);
    c.save();
    c.font = `600 12px ${T.body}`;
    c.textBaseline = "middle";
    c.textAlign = "right";
    for (const f of order) {
      if (f === OTHER || !lastLin[f] || !tot) continue;
      const b = bands.get(f);
      const hh = (b.y1[lastSi] - b.y0[lastSi]) * h;
      if (hh < 15) continue;
      const text = `${short(f)} ${Math.round((valueOf(lastLin[f], S.mode) / tot) * 100)}%`;
      const tw = c.measureText(text).width + 10;
      const cy = ((b.y0[lastSi] + b.y1[lastSi]) / 2) * h;
      c.fillStyle = T.paper;
      c.globalAlpha = 0.72;
      c.beginPath();
      c.roundRect(w - tw - 22, cy - 9, tw, 18, 2);
      c.fill();
      c.globalAlpha = 1;
      c.fillStyle = T.ink;
      c.fillText(text, w - 27, cy + 0.5);
    }
    c.restore();
  }


  // Guard lane: every tick the guard blocked a payment, in the signal colour.
  // Ticks closer than a few pixels merge into the one already drawn, so a busy stretch reads as a row of marks,
  // not a solid smear (on a phone a pixel spans several rounds).
  const D = S.derived;
  const narrow = gl.w < 560, gap = narrow ? 7 : 4, bw = narrow ? 2 : 3;
  let lastX = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = D[i];
    const x = xt(S.metrics[i].tick);
    if (d.blocked > 0 && x - lastX >= gap) {
      lastX = x;
      gl.c.fillStyle = T.accent;
      const hh = Math.min(gl.h, 8 + d.blocked * 3);
      gl.c.fillRect(x - bw / 2, (gl.h - hh) / 2, bw, hh);
    }
    if (d.leaked > 0) {
      gl.c.fillStyle = T.error;
      gl.c.fillRect(xt(S.metrics[i].tick) - 1, 0, 2, gl.h);
    }
  }
  drawAiLane(xt);
  renderAxis(geo);
  renderKey(sc, D);
  narrate();
  // The pooled band's label is drawn once the narration pin is placed, so the two never cover each other.
  const ob = order.includes(OTHER) && bands.get(OTHER);
  if (ob && ob.first >= 0) labelOther(c, ob, h, pinPos());
}

// The AI lane: one mark per round in which an AI model designed a child, taller for more; the decision shown
// above the chart gets a ring here and a diamond in its family's band.
function drawAiLane(xt) {
  const lane = $(".lane--ai");
  const kids = claudeChildren();
  lane.hidden = !kids.length;
  if (!kids.length) return;
  const { c, w, h } = sizeCanvas(aiCv);
  c.clearRect(0, 0, w, h);
  const per = new Map();
  for (const a of kids) { const px = Math.round(xt(a.born)); per.set(px, (per.get(px) || 0) + 1); }
  c.fillStyle = T.ai;
  for (const [px, k] of per) { const hh = Math.min(h, 4 + k * 3); c.fillRect(px - 1, (h - hh) / 2, 2, hh); }
  const cur = pickDecision();
  if (!cur) return;
  const px = Math.max(5, Math.min(w - 5, xt(cur.born)));
  c.strokeStyle = T.ink;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(px, h / 2, 6, 0, Math.PI * 2);
  c.stroke();
}

// The key lists only what the plot is showing right now.
function renderKey(sc, D) {
  const last = S.metrics[S.metrics.length - 1];
  const show = {
    ai: !$(".lane--ai").hidden,
    other: !!geo?.bands.has(OTHER),
    scar: sc.length > 0,
    shock: shockSpans().length > 0 || S.shockMarks.length > 0,
    guard: D.some((d) => d.blocked > 0),
    gens: !!geo?.gens,
  };
  const note = $("#axis-note");
  note.hidden = geo?.tD == null;
  const sr = S.state?.startRound || 0;
  if (geo?.tD != null) note.textContent = `Left of the dashed line: rounds ${geo.t0} to ${geo.tD}, compressed.${sr ? ` This run opened at round ${fmt(sr)}; the quieter rounds before it played in fast-forward and are all shown.` : ""}`;
  void last;
  const thick = S.mode === "wealth" ? "more money" : "more agents alive";
  $("#read-sentence").textContent = innerWidth < 640 ? `Each colour is a family. Thicker = ${thick}; tap a band for its true share.` : `Each colour is a family. Thicker = ${thick}; heights are compressed, so hover a band for its true share.`;
  if (geo?.gens) {
    const gg = geo.gens;
    $("#key-gens-text").textContent = `Shades inside ${short(gg.f)}’s colour: generations, oldest lightest`;
    $("#key-gens-swatch").style.background = `linear-gradient(90deg, ${gg.lite}, ${gg.deep})`;
  }
  $$("#key [data-key]").forEach((el) => (el.hidden = !show[el.dataset.key]));
}

// Screen readers hear the headline when it changes, at most once every 12 seconds.
let spoken = "", spokenAt = 0, spokenTimer = 0;
// A direct answer to a key press is spoken at once and holds the region for those 12 seconds.
function announce(text, now = false) {
  if (!text || (text === spoken && !now)) return;
  clearTimeout(spokenTimer);
  const say = () => { spoken = text; spokenAt = Date.now(); $("#headline-live").textContent = text; };
  if (now) return say();
  spokenTimer = setTimeout(say, Math.max(0, spokenAt + 12000 - Date.now()));
}

function drawNotes(points, xt) {
  const ROW_H = 20, MAX_ROWS = 3, PAD = 10;
  const rows = Array.from({ length: MAX_ROWS }, () => []); // row 0 sits nearest the plot
  const placed = [];
  const w = canvas.clientWidth;
  const mc = notesCv.getContext("2d");
  mc.font = `500 12px ${T.body}`;
  const clear = (row, a, z) => row.every(([b0, b1]) => z + PAD < b0 || a > b1 + PAD);
  // Placed right to left, so each earlier note can climb a row and sit above the later notes' start while
  // its own leader passes to their left: three events close together form a staircase instead of colliding.
  for (const p of [...points].sort((a, b) => b.tick - a.tick)) {
    const xx = Math.round(xt(p.tick)) + 0.5;
    const text = p.lines.join(" ");
    const tw = mc.measureText(text).width + 8;
    let lx = Math.min(Math.max(0, xx - 4), w - tw);
    if (lx < 0) continue;
    const lead = [xx - 2, xx + 2];
    const r = rows.findIndex((row, ri) => clear(row, lx, lx + tw) && rows.slice(0, ri).every((below) => clear(below, lead[0], lead[1])));
    if (r < 0) continue;
    rows[r].push([lx, lx + tw]);
    for (let i = 0; i < r; i++) rows[i].push(lead);
    placed.push({ xx, lx, r, text });
  }
  const used = placed.length ? Math.max(...placed.map((p) => p.r)) + 1 : 0;
  notesCv.parentElement.hidden = !used;
  if (!used) return;
  notesCv.style.height = `${used * ROW_H + 6}px`;
  const { c, h } = sizeCanvas(notesCv);
  // the lane was sized while hidden on an earlier frame; keep its width in step with the plot
  c.clearRect(0, 0, w, h);
  c.font = `500 12px ${T.body}`;
  c.textBaseline = "middle";
  for (const p of placed) {
    const cy = h - 6 - p.r * ROW_H - ROW_H / 2;
    c.strokeStyle = T.muted;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(p.xx, cy + ROW_H / 2 - 2);
    c.lineTo(p.xx, h);
    c.stroke();
    c.fillStyle = T.ink;
    c.fillText(p.text, p.lx + 4, cy);
  }
}

// Turning points across the whole run, every one read from the metrics and events the run produced:
// the largest extinction, each dynasty that passes half the population, challengers that together climb back above
// REINVADE of the population after a leader took over, the guard's first block, and shocks. The first three
// kinds of note are always offered; the rest are picked to spread over time, so a long run is annotated
// end to end rather than only at its start. drawNotes drops any that cannot fit without a collision.
const REINVADE = 0.07, REARM = 0.06, REINVADE_GAP = 40, MAX_NOTES = 7;
function turningPoints(sc) {
  const M = S.metrics, D = S.derived, must = [], rest = [];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const big = sc.reduce((a, s) => (!a || s.deaths > a.deaths ? s : a), null);
  if (big) must.push({ tick: big.tick, scar: true, lines: [`Round ${big.tick}. ${big.deaths} died,`, `${big.ended} ${plural(big.ended, "family", "families")} ended.`] });

  // One pass over the shares: who holds half, and when challengers win ground back from that leader. A
  // reinvasion is everyone but the leader together climbing above REINVADE after falling below REARM; the
  // note names the largest challenger at the wave's peak.
  // A wave that starts again within REINVADE_GAP ticks of the last one ending is the same wave.
  let lead = null, armed = false, wave = null;
  const waves = [];
  const closeWave = (tick) => { if (wave) { wave.end = tick; waves.push(wave); } wave = null; };
  const biggestRival = (lin) => { let bf = null, bn = 0; for (const f in lin) if (f !== lead && lin[f].n > bn) { bn = lin[f].n; bf = f; } return bf; };
  for (const m of M) {
    const lin = m.lineages || {};
    let total = 0, top = null, topN = 0;
    for (const f in lin) { total += lin[f].n; if (lin[f].n > topN) { topN = lin[f].n; top = f; } }
    if (!total) continue;
    if (topN / total > 0.5 && top !== lead) {
      const first = lead === null;
      closeWave(m.tick);
      lead = top;
      armed = false;
      const note = { tick: m.tick, lines: [`Round ${m.tick}. ${short(top)}`, first ? "passes half." : "takes over half."] };
      first ? must.push(note) : rest.push({ ...note, score: 1 });
      continue;
    }
    if (!lead) continue;
    const rival = 1 - (lin[lead]?.n || 0) / total;
    if (wave) {
      if (rival > wave.peak) { wave.peak = rival; wave.f = biggestRival(lin); }
      if (rival < REARM) { closeWave(m.tick); armed = true; }
    } else if (rival < REARM) armed = true;
    else if (armed && rival >= REINVADE) {
      armed = false;
      const prev = waves[waves.length - 1];
      if (prev && prev.lead === lead && m.tick - prev.end < REINVADE_GAP) wave = waves.pop();
      else wave = { lead, f: biggestRival(lin), tick: m.tick, peak: rival };
      if (rival > wave.peak) { wave.peak = rival; wave.f = biggestRival(lin); }
    }
  }
  closeWave(Infinity);
  for (const v of waves) rest.push({ tick: v.tick, score: v.peak, lines: [`Round ${v.tick}. Rivals, led by ${short(v.f)},`, `retake ${pct(v.peak)}.`] });

  const mono = monoculture();
  if (mono) must.push({ tick: mono.tick, lines: [`Round ${mono.tick}. ${short(mono.f)} holds`, `${mono.all ? "every agent" : `over ${Math.round(MONO_SHARE * 100)}%`}.`] });
  const gi = D.findIndex((d) => d.blocked > 0);
  if (gi >= 0) must.push({ tick: M[gi].tick, lines: [`Round ${M[gi].tick}.`, "First guard block."] });
  for (const s of shockSpans()) rest.push({ tick: s.from, score: 0.5, lines: [`Round ${s.from}.`, `${s.kind === "plague" ? "Plague" : "Drought"} begins.`] });
  for (const m of S.shockMarks) rest.push({ tick: m.tick, score: 0.3, lines: [`Round ${m.tick}.`, m.kind === "rogue" ? "A rogue is released." : "Newcomers arrive."] });

  // Spread: repeatedly take the candidate farthest in time from every note already chosen, larger events
  // breaking near-ties, until the budget is spent.
  const out = must.slice(0, MAX_NOTES);
  const span = Math.max(1, (M[M.length - 1]?.tick ?? 1) - (M[0]?.tick ?? 0));
  const pool = rest.slice();
  while (out.length < MAX_NOTES && pool.length) {
    let bi = 0, best = -Infinity;
    pool.forEach((p, i) => {
      const gap = out.length ? Math.min(...out.map((o) => Math.abs(o.tick - p.tick))) / span : 1;
      const v = gap + 0.05 * p.score;
      if (v > best) { best = v; bi = i; }
    });
    out.push(pool.splice(bi, 1)[0]);
  }
  return out;
}

// One line under the counter: the most notable fact about the run right now, by simple rules.
function headline() {
  const M = S.metrics, n = M.length;
  if (!n) return "";
  const m = M[n - 1];
  const deathsSince = (tick) => {
    const before = [...M].reverse().find((x) => x.tick < tick);
    return m.deaths - (before ? before.deaths : 0);
  };
  // 1. A drought or plague under way, or just over, that has killed agents.
  const spans = shockSpans().filter((s) => m.tick - s.to <= 10).sort((a, b) => b.from - a.from);
  for (const s of spans) {
    const k = deathsSince(s.from);
    const on = (m.shocks || {})[s.kind] > m.tick;
    if (k > 0) return on ? `A ${s.kind} is under way and has killed ${fmt(k)} so far` : `A ${s.kind} just killed ${fmt(k)}`;
  }
  // 2. A mass extinction in the last 15 ticks.
  const sc = scars().filter((s) => m.tick - s.tick <= 15).pop();
  if (sc) return `A mass extinction just killed ${fmt(sc.deaths)} and ended ${lower(word(sc.ended))} ${plural(sc.ended, "family", "families")}`;
  const lead = leader();
  const pct = (x) => `${Math.round(x * 100)}%`;
  // 3. While no dynasty has a quarter of the population, the race between lines is the story; only middlemen
  // reselling a large cut of the work beat it.
  if (lead && lead.share < 0.25) {
    if (m.middlemanShare >= 0.3) return `Middlemen, agents who resell work they win, handled ${pct(m.middlemanShare)} of it in the last ${Math.min(50, m.tick)} rounds`;
    // A lead only counts when it is a lead: more than one agent and no dynasty level with it.
    return leadSentence(view());
  }
  // 4. One dynasty holding most of the population.
  const holds = (f, x) => { const st = strategyOf(f); return st ? `${short(f)}’s family of ${st.split(",")[0]} has ${x} of the agents alive now` : `One family, ${short(f)}’s, has ${x} of the agents alive now`; };
  if (lead && lead.share >= 0.7) return holds(lead.f, pct(lead.share));
  // 5. Middlemen taking a large cut of the work.
  if (m.middlemanShare >= 0.3) return `Middlemen, agents who resell work they win, handled ${pct(m.middlemanShare)} of it in the last ${Math.min(50, m.tick)} rounds`;
  if (lead && lead.share >= 0.5) return holds(lead.f, pct(lead.share));
  if (m.middlemanShare >= 0.15) return `Middlemen, agents who resell work they win, handled ${pct(m.middlemanShare)} of it in the last ${Math.min(50, m.tick)} rounds`;
  // 6. Otherwise, how open the field still is.
  return openField();
}

// The status line under the headline already gives the counts; the headline names the leader from the same reading.
function openField() {
  return leadSentence(view());
}

// The opening frame: while the run is young, say what the even stripes are, from the founding tick's own data.
const OPENING = 60;
function renderCaption() {
  const cap = $("#plot-caption");
  const M = S.metrics;
  const last = M[M.length - 1];
  // One overlay at a time: the opening caption stays hidden while the guide is open.
  const early = last && last.tick < OPENING && !tour.open;
  if (early) {
    const t0 = M[0].tick;
    const founding = [...S.founders.values()].filter((r) => r.first === t0).length;
    const lin = M[0].lineages || {};
    const sizes = new Set(Object.values(lin).map((l) => l.n));
    const one = sizes.size === 1 && sizes.has(1);
    cap.textContent = `${fmt(founding)} founding agents${one ? " with equal money" : ""}, each starting a family. Watch which families grow.`;
  }
  cap.hidden = !early;
}

// ---------- narration: one plain sentence on what just happened, with a pin where it is on the chart ----------
// Read from the run's own events and metrics. A sentence holds for at least NARR_HOLD ms so it can be read;
// candidates that pile up meanwhile compete, and the most telling (latest on a tie) is said next.
const NARR_HOLD = 6500, NARR_URGENT = 2500;
const N = {};
function narrReset() {
  Object.assign(N, { cur: null, at: 0, pending: [], scanned: -1, rising: new Set(), mid: false, killing: 0 });
}
narrReset();
const nth = (n) => { const v = n % 100, s = ["th", "st", "nd", "rd"]; return `${fmt(n)}${s[(v - 20) % 10] || s[v] || s[0]}`; };
function sharesOf(m) {
  const v = m === S.metrics[S.metrics.length - 1] ? view() : summarize(m);
  return { lin: m.lineages || {}, total: v.population, top: v.leader, share: v.share };
}
const pctOf = (x) => `${Math.round(x * 100)}%`;

function narrCandidates(i) {
  const M = S.metrics, D = S.derived, m = M[i], out = [];
  const add = (pri, text, at, f = null, tick = m.tick) => out.push({ pri, text, at, f, tick });
  const now = sharesOf(m), before = i ? sharesOf(M[i - 1]) : null;
  const g = S.notes.get(m.tick);
  if (g) {
    for (const e of g.shocks) {
      if (e.shock === "plague") add(9, `A plague just struck: every agent pays triple rent until round ${e.until}. The poorest will go broke first`, "top");
      else if (e.shock === "drought") add(9, `A drought just began: only a third as many tasks until round ${e.until}, so agents fight over less work`, "top");
      else if (e.shock === "rogue") add(9, "A new rogue agent was just released. It will try to steal; watch the guard’s green marks", "guard");
      else if (e.shock === "immigration") add(9, `${word(g.arrivals.length || 6)} newcomers just arrived with random strategies, each founding a new family`, "top");
    }
    if (g.rogues.length && !g.shocks.some((e) => e.shock === "rogue")) add(9, "A rogue agent just entered the market. It will try to steal by paying an accomplice", "guard");
    if (g.guard.length) {
      let k = 0;
      for (let j = 0; j <= i; j++) if (D[j].blocked > 0) k++;
      const e = g.guard[0];
      add(8, e.attack === "race" ? `The guard just clamped a burst of rogue payments: ${credits(e.amount)} credits over the rogue’s hourly cap, blocked` : `The guard just blocked the rogue’s ${nth(k)} theft: ${credits(e.amount)} credits it tried to slip to its accomplice`, "guard");
    }
    if (g.subs.length && !N.mid) {
      N.mid = true;
      add(6, "An agent just became a middleman: it won a task, paid a cheaper agent to do it and kept the difference", "top");
    }
    const routine = g.kills.length && !D[i].ended.length;
    if (routine) {
      const fs = new Set(g.kills.map((e) => founderOf(e.agent)));
      const one = fs.size === 1 && !fs.has(null) ? [...fs][0] : null;
      const k = g.kills.length;
      add(4, one ? `${k === 1 ? "An agent" : `${word(k)} agents`} in ${short(one)}’s family just went broke and died: rent ate ${k === 1 ? "its" : "their"} savings`
        : `${word(k)} ${plural(k, "agent")} just went broke and died: rent ate ${k === 1 ? "its" : "their"} savings`, one ? "band" : "top", one, i ? M[i - 1].tick : m.tick);
    }
  }
  // Dynasties that died out this tick.
  const ended = D[i].ended;
  if (ended.length === 1) add(9, `${short(ended[0])}’s family just died out: its last agent went broke`, "band", ended[0], i ? M[i - 1].tick : m.tick);
  else if (ended.length > 1) add(9, `${word(ended.length)} families just died out at once, ${now.top ? `leaving ${short(now.top)}’s the largest` : "their last agents broke"}`, "mid");
  // A dynasty passing half the population.
  if (before && now.top && now.share(now.top) > 0.5 && !(before.top === now.top && before.share(before.top) > 0.5))
    add(7, `${short(now.top)}’s family just passed half of all agents`, "band", now.top);
  // A rival rising from almost nothing: under 2% sixty ticks ago, 5% or more now.
  if (i >= 60) {
    const old = sharesOf(M[i - 60]);
    for (const f in now.lin) {
      if (f === now.top) continue;
      const s = now.share(f);
      if (s < 0.01) N.rising.delete(f);
      if (s >= 0.05 && old.share(f) < 0.02 && !N.rising.has(f)) {
        N.rising.add(f);
        add(7, `A new rival is rising: ${short(f)}’s family grew from ${old.share(f) < 0.005 ? "almost nothing" : pctOf(old.share(f))} to ${pctOf(s)} of all agents`, "band", f);
      }
    }
  }
  // A shock under way, and whose agents it is killing.
  const span = shockSpans().find((sp) => sp.from <= m.tick && (m.shocks || {})[sp.kind] > m.tick);
  if (span) {
    const by = new Map();
    for (const [t, gg] of S.notes) if (t >= span.from && t <= m.tick) for (const e of gg.kills) { const f = founderOf(e.agent); if (f) by.set(f, (by.get(f) || 0) + 1); }
    let bf = null, bk = 0;
    for (const [f, k] of by) if (k > bk) { bk = k; bf = f; }
    if (bf && bk >= 3 && bk >= N.killing + 2) {
      N.killing = bk;
      add(8, `The ${span.kind} is ${span.kind === "plague" ? "killing" : "starving"} ${short(bf)}’s family: ${fmt(bk)} of its agents have gone broke since it began`, "band", bf);
    }
  } else N.killing = 0;
  // Forks: the dynasty that forked most this tick.
  let ff = null, fk = 0;
  for (const f in now.lin) if ((now.lin[f].forks || 0) > fk) { fk = now.lin[f].forks; ff = f; }
  const byAi = ff ? S.designs.find((d) => d.tick === m.tick && d.founder === ff) : null;
  if (ff && byAi) add(3, fk === 1 ? `${short(ff)}’s family just grew: a rich agent forked a child, and ${modelName(byAi.model)} chose its strategy`
    : `${short(ff)}’s family just forked ${lower(word(fk))} children, their strategies chosen by ${modelName(byAi.model)}`, "band", ff);
  else if (ff) add(3, fk === 1 ? `${short(ff)}’s family just grew: a rich agent forked a child that copies it with small random changes`
    : `${short(ff)}’s family just forked ${lower(word(fk))} children: rich agents copy themselves with small random changes`, "band", ff);
  if (now.top && now.share(now.top) >= 0.98) add(1, `${short(now.top)}’s family holds almost every agent. Any challenger must now arise as one of its own mutants`, "band", now.top);
  return out;
}

function narrate() {
  const M = S.metrics, el = $("#narr");
  if (!M.length) { el.hidden = true; $("#narr-pin").hidden = true; return; }
  const lastTick = M[M.length - 1].tick;
  if (N.scanned < 0) {
    // A page opened mid-run starts its story 40 ticks back; anything earlier, such as the first middleman, is old news.
    N.scanned = Math.max(0, lastTick - 40);
    N.mid = M.some((m) => m.tick <= N.scanned && m.middlemanShare > 0);
  }
  let i = M.length - 1;
  while (i > 0 && M[i - 1].tick > N.scanned) i--;
  for (; i < M.length; i++) if (M[i].tick > N.scanned) N.pending.push(...narrCandidates(i));
  N.scanned = lastTick;
  if (N.pending.length > 120) N.pending = N.pending.sort((a, b) => b.pri - a.pri || b.tick - a.tick).slice(0, 40);
  const t = Date.now();
  const best = N.pending.reduce((a, c) => (!a || c.pri > a.pri || (c.pri === a.pri && c.tick >= a.tick) ? c : a), null);
  const due = !N.cur || t - N.at >= NARR_HOLD || (best && best.pri >= 8 && N.cur.pri < 5 && t - N.at >= NARR_URGENT);
  if (best && due) {
    N.cur = best;
    N.at = t;
    N.pending = [];
    // The round it happened in, so an event about one family never reads as a ranking beside "Who is ahead".
    $("#narr-text").textContent = `Round ${fmt(best.tick)}: ${best.text}.`;
    el.hidden = false;
    // restart the entrance so a new sentence reads as new
    el.classList.remove("is-new");
    void el.offsetWidth;
    el.classList.add("is-new");
  }
  const lbl = S.state?.finished ? "At the end" : "Just now";
  if ($(".narr__label").textContent !== lbl) $(".narr__label").textContent = lbl;
  placeNarrPin();
}

// The pin: where the narrated event sits on the chart, in the band it is about when there is one.
function placeNarrPin() {
  const pin = $("#narr-pin");
  const p = pinPos();
  if (!p) { pin.hidden = true; return; }
  const well = $(".plot__well").getBoundingClientRect(), box = plot.getBoundingClientRect();
  pin.style.transform = `translate(${well.left - box.left + p.x}px, ${well.top - box.top + p.y}px)`;
  pin.hidden = false;
}
// The pin's centre in the plot well's own coordinates (the canvas's), or null when there is none.
function pinPos() {
  const c = N.cur;
  if (!c || !geo || plot.dataset.state !== "full") return null;
  const well = $(".plot__well").getBoundingClientRect();
  const x = Math.max(0, Math.min(geo.w, geo.xt(c.tick)));
  let y = 10;
  if (c.at === "guard") y = guardCv.getBoundingClientRect().top - well.top + guardCv.clientHeight / 2;
  else if (c.at === "mid") y = well.height / 2;
  else if (c.at === "band" && c.f) {
    const M = S.metrics, { samples } = geo;
    let si = samples.length - 1;
    while (si > 0 && M[samples[si]].tick > c.tick) si--;
    const pick = (f) => { for (let k = si; k >= 0; k--) { const b = geo.bands.get(f); if (b && b.y1[k] > b.y0[k] && !(f !== OTHER && geo.pooledAt(f, k))) return (b.y0[k] + b.y1[k]) / 2; } return null; };
    const fy = pick(c.f) ?? pick(OTHER);
    if (fy !== null) y = fy * well.height;
  }
  return { x, y };
}

function shockSpans() {
  const spans = [];
  const open = {};
  for (const m of S.metrics) {
    const active = m.shocks || {};
    for (const k of ["drought", "plague"]) {
      const on = active[k] !== undefined && m.tick < active[k];
      if (on && !open[k]) open[k] = { kind: k, from: m.tick, to: m.tick };
      else if (on) open[k].to = m.tick;
      else if (!on && open[k]) { spans.push(open[k]); open[k] = null; }
    }
  }
  for (const k in open) if (open[k]) spans.push(open[k]);
  return spans;
}

function renderAxis(g) {
  const axis = $("#axis");
  if (!g) { axis.innerHTML = ""; return; }
  const W = axis.clientWidth || g.w;
  const from = g.tD ?? g.t0;
  const span = g.t1 - from;
  const raw = span / ((W < 560 ? 3 : 7) * (1 - (g.tD === null ? 0 : g.fD)));
  const mag = 10 ** Math.floor(Math.log10(raw));
  // Ticks are whole numbers: never step by less than one.
  const stepT = Math.max(1, Math.round([1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw));
  const px = (t) => (g.xt(t) / g.w) * W;
  const at = (t) => `${(g.xt(t) / g.w) * 100}%`;
  const out = [];
  let lastPx = -Infinity;
  if (g.tD !== null) {
    // The squeezed opening gets a bracket and a name instead of crowded round numbers.
    const wpx = px(g.tD);
    const name = wpx >= 96 ? "early rounds (compressed)" : "early";
    out.push(`<span class="axis__early" style="left:0;width:${at(g.tD)}" title="Rounds ${g.t0} to ${g.tD}, while the founding families were still near-equal, squeezed into this strip">${name}</span>`);
    out.push(`<span class="axis__brk" style="left:${at(g.tD)}">${g.tD}</span>`);
    lastPx = wpx;
  } else {
    out.push(`<span class="axis__first" style="left:0">round ${g.t0}</span>`);
    lastPx = 60;
  }
  const endPx = W - (W < 560 ? 150 : 170);
  for (let t = Math.ceil((from + stepT * 0.6) / stepT) * stepT; t < g.t1; t += stepT) {
    const p = px(t);
    if (p - lastPx < 48 || p > endPx) continue;
    out.push(`<span style="left:${at(t)}">${t}</span>`);
    lastPx = p;
  }
  out.push(`<span class="axis__now" style="left:100%">now · round ${fmt(g.t1)}</span>`);
  axis.innerHTML = out.join("");
}

// Hover and selection
function hitTest(px, py) {
  if (!geo) return null;
  const { samples, bands, order, x } = geo;
  let si = 0, best = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(x(i) - px);
    if (d < best) { best = d; si = i; }
  }
  const fy = py / canvas.clientHeight;
  for (const f of order) {
    const b = bands.get(f);
    if (b.y1[si] > b.y0[si] && fy >= b.y0[si] && fy <= b.y1[si]) return { f, mi: samples[si] };
  }
  return null;
}

// A dynasty's strategy in a few plain words, from its living members' mean genome.
const KIND_WORDS = { arith: "arithmetic", extract: "extraction", classify: "classification", reason: "reasoning" };
function strategyOf(f) {
  const living = [...S.agents.values()].filter((a) => a.founder === f && a.alive && a.role === "parametric");
  if (!living.length) return null;
  const mean = (k) => living.reduce((s, a) => s + a[k], 0) / living.length;
  const markup = mean("markup"), sub = mean("subcontract");
  const spec = KINDS.map((_, i) => living.reduce((s, a) => s + a.spec[i], 0) / living.length);
  const top = spec.indexOf(Math.max(...spec));
  // Labels change only once a gene clears its threshold by a margin, so a mean hovering on a line does not flicker.
  const prev = STRAT_MEMO.get(f) || {};
  const band = (v, cuts, old) => {
    const raw = cuts.findIndex((c) => v < c);
    const i = raw === -1 ? cuts.length : raw;
    if (old === undefined || i === old) return i;
    const edge = i > old ? cuts[i - 1] : cuts[i];
    return Math.abs(v - edge) >= HYST ? i : old;
  };
  const pi = band(markup, [0.5, 0.75], prev.pi);
  const si = band(spec[top], [0.4], prev.si);
  const ri = band(sub, [0.45], prev.ri);
  STRAT_MEMO.set(f, { pi, si, ri });
  const price = ["cheap bids", "mid-price bids", "pricey bids"][pi];
  const skill = si === 1 ? `${KIND_WORDS[KINDS[top]]} specialists` : "generalists";
  return `${skill}, ${price}${ri === 1 ? ", resell work" : ""}`;
}
const STRAT_MEMO = new Map();
const HYST = 0.04;

function dynastyFacts(f) {
  const living = [...S.agents.values()].filter((a) => a.founder === f && a.alive && a.role === "parametric");
  const founder = S.agents.get(f);
  const gens = living.length ? Math.max(...living.map((a) => a.generation)) : null;
  return { living, founder, gens };
}

canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const hit = hitTest(px, py);
  const tip = $("#tip");
  const prev = S.hover;
  S.hover = hit?.f ?? null;
  if (!hit) { tip.hidden = true; if (prev) schedule("plot"); return; }
  const m = S.metrics[hit.mi];
  if (hit.f === OTHER) {
    const si = geo.samples.indexOf(hit.mi);
    const small = Object.keys(m.lineages).filter((f) => geo.pooledAt(f, si));
    const n = small.reduce((a, f) => a + m.lineages[f].n, 0);
    tip.innerHTML = `<b>Small families</b><span>At round ${m.tick}: ${lower(word(small.length))} small ${plural(small.length, "family", "families")}, ${n} agents in all.</span><br>` +
      `<span>None is big enough yet for a colour of its own, so they share this speckled band, drawn smaller than their share so the named families stay readable. Any that grows gets its own colour.</span>`;
  } else {
  const lin = m.lineages[hit.f];
  const { living, founder, gens } = dynastyFacts(hit.f);
  const nowAlive = living.length > 0;
  const tot = Object.values(m.lineages).reduce((a, l) => a + (S.mode === "wealth" ? l.wealth : l.n), 0);
  const share = tot ? Math.round(((S.mode === "wealth" ? lin.wealth : lin.n) / tot) * 100) : 0;
  const strat = strategyOf(hit.f);
  tip.innerHTML = `<b>${esc(short(hit.f))}’s family</b>` +
    (strat ? `<em>${esc(strat)}</em>` : "") +
    `<span>At round ${m.tick}: ${share}% of the ${S.mode === "wealth" ? "wealth" : "population"}, ${lin.n} living, ${credits(lin.wealth)} credits.</span><br>` +
    `<span>${nowAlive ? `Now ${living.length} living, ${gens + 1} ${plural(gens + 1, "generation")} deep` : "Extinct now"}. Founded at round ${founder?.born ?? S.founders.get(hit.f)?.first ?? 0}.</span>` +
    (nowAlive && living.some((a) => a.origin === "llm") ? `<br><span class="tip__ai">An AI model designed ${living.filter((a) => a.origin === "llm").length} of its ${living.length} living members.</span>` : "");
  }
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let tx = px + 14, ty = py + 14;
  if (tx + tw > r.width) tx = px - tw - 14;
  if (ty + th > r.height) ty = Math.max(0, py - th - 14);
  tip.style.transform = `translate(${tx}px, ${ty}px)`;
  if (prev !== S.hover) schedule("plot");
});
canvas.addEventListener("mouseleave", () => {
  $("#tip").hidden = true;
  S.hover = null;
  schedule("plot");
});
canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect();
  const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
  select(hit && hit.f !== OTHER ? (hit.f === S.selected ? null : hit.f) : null);
});
canvas.addEventListener("keydown", (e) => {
  if (!["ArrowUp", "ArrowDown", "Escape", "Enter", " "].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { select(null); announce("Back to the richest family", true); return; }
  const last = S.metrics[S.metrics.length - 1];
  if (!last) return;
  const lastSi = geo ? geo.samples.length - 1 : 0;
  const alive = Object.keys(last.lineages).filter((f) => !geo || !geo.pooledAt(f, lastSi)).sort((a, b) => S.founders.get(a).idx - S.founders.get(b).idx);
  if (!alive.length) return;
  const i = alive.indexOf(S.selected);
  const pick = e.key === "Enter" || e.key === " "
    ? (S.selected && i >= 0 ? S.selected : leader()?.f ?? alive[0])
    : alive[e.key === "ArrowDown" ? (i + 1) % alive.length : (i <= 0 ? alive.length - 1 : i - 1)];
  select(pick);
  const n = last.lineages[pick]?.n ?? 0, tot = Object.values(last.lineages).reduce((a, l) => a + l.n, 0);
  const st = strategyOf(pick);
  announce(`${short(pick)}’s family, ${tot ? Math.round((n / tot) * 100) : 0}% of the population${st ? `, ${st}` : ""}. Details in the strategy panel.`, true);
});

function setParam(k, v) {
  const u = new URL(location.href);
  if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
  history.replaceState(null, "", u);
}

function select(f) {
  S.selected = f;
  const u = new URL(location.href);
  if (f) u.searchParams.set("dynasty", short(f)); else u.searchParams.delete("dynasty");
  history.replaceState(null, "", u);
  schedule("plot");
  schedule("specimen");
}

$$("#mode input").forEach((i) => i.addEventListener("change", () => {
  S.mode = i.value;
  const u = new URL(location.href);
  if (S.mode === "wealth") u.searchParams.set("band", "wealth"); else u.searchParams.delete("band");
  history.replaceState(null, "", u);
  schedule("plot");
}));

// ---------- specimen ----------
function richestFounder() {
  const last = S.metrics[S.metrics.length - 1];
  if (!last) return null;
  let best = null, bw = -Infinity;
  for (const f in last.lineages) if (last.lineages[f].wealth > bw) { bw = last.lineages[f].wealth; best = f; }
  return best;
}

// Why a dynasty wins, in one sentence: its price and reselling against the market's averages, from the snapshot.
function renderSpecimen() {
  const body = $("#spec-body");
  const sub = $("#spec-sub");
  const f = S.selected || richestFounder();
  if (!f) {
    sub.textContent = "The richest family’s strategy, until you pick a band.";
    body.innerHTML = `<p class="placeholder">${S.metrics.length ? "No family is alive." : "No family has a record yet."}</p>`;
    return;
  }
  $("#spec-h").textContent = "Family strategy";
  sub.textContent = S.selected ? "The band you picked. Click it again, or press Escape on the plot, to go back to the richest." : "The richest family’s strategy. Click a band to see another.";
  const { living, founder, gens } = dynastyFacts(f);
  const lead = leader();
  const colour = colourOf(f, !!lead && lead.f === f && lead.share >= LEAD_SHARE);
  const last = S.metrics[S.metrics.length - 1];
  const lin = last?.lineages[f];

  if (!living.length) {
    let endTick = null;
    for (let i = S.derived.length - 1; i >= 0; i--) if (S.derived[i].ended.includes(f)) { endTick = S.metrics[i].tick; break; }
    body.innerHTML = `<div class="spec__name"><span class="spec__swatch" style="background:${colour}"></span><h3>${esc(short(f))}’s family</h3></div>` +
      `<p>This family is extinct${endTick !== null ? `; its last member died at round ${endTick}` : ""}. Its strategy went with it.</p>`;
    return;
  }

  const ex = S.exportInfo && !S.exportInfo.error ? S.exportInfo : null;
  const isChampLine = ex && ex.dynasty.founder === f;
  const champ = isChampLine ? ex.champion.id : living.reduce((a, b) => (b.balance > a.balance ? b : a)).id;
  const mean = (k) => living.reduce((s, a) => s + a[k], 0) / living.length;
  const specMean = KINDS.map((_, i) => living.reduce((s, a) => s + a.spec[i], 0) / living.length);
  const specialisation = living.reduce((s, a) => s + Math.max(...a.spec), 0) / living.length;

  // Every gene is in the snapshot; older servers may omit some, which then show as not reported.
  const meanOr = (k) => (living.every((a) => typeof a[k] === "number") ? mean(k) : null);
  const g3 = { risk: meanOr("risk"), reserve: meanOr("reserve"), forkAt: meanOr("forkAt"), source: "all" };

  // Every living parametric agent in the market, for the average mark on each gene's track.
  const market = [...S.agents.values()].filter((a) => a.alive && a.role === "parametric");
  const avg = (k) => (market.length && market.every((a) => typeof a[k] === "number") ? market.reduce((s, a) => s + a[k], 0) / market.length : null);
  const avgSpec = market.length ? market.reduce((s, a) => s + Math.max(...a.spec), 0) / market.length : null;
  const clamp = (v, max) => Math.max(0.01, Math.min(1, v / max));
  const gene = (label, hint, v, max, shown, mk) => `<div class="gene"><dt>${label}<small>${hint}</small></dt><dd>${v === null
    ? `<span class="none">Not reported yet</span>`
    : `<div class="track"><span class="fill" style="background:${colour};transform:scaleX(${clamp(v, max)})"></span>${mk === null || mk === undefined ? "" : `<span class="avg" style="left:${clamp(mk, max) * 100}%"></span>`}</div>`}</dd><dd class="val">${v === null ? "" : shown}${mk === null || mk === undefined ? "" : `<small>avg ${mk.toFixed(2)}</small>`}</dd></div>`;

  const facts = [
    ["Living members", fmt(living.length)],
    ["Wealth", `${credits(lin ? lin.wealth : living.reduce((s, a) => s + a.balance, 0))} credits`],
    ["Generations", `${gens + 1} deep`],
    ["Founded", `round ${founder?.born ?? S.founders.get(f)?.first ?? 0}`],
    ["Founder", short(f)],
    [isChampLine ? "Champion, its top earner" : "Champion, its richest member", short(champ)],
  ];
  let note = `A strategy is the set of numbers an agent bids by. ${living.some((a) => a.origin === "llm") ? "A child’s strategy is its parent’s, adjusted by an AI model or by small random changes." : "A child inherits them with small random changes."} Bars average the family’s living members; the white mark is the whole market’s average.`;
  if (!isChampLine && g3.source !== "all") {
    note += g3.source ? ` Risk, reserve and fork threshold average the ${g3.source} of ${living.length} members born while this page was open.` : " Risk, reserve and fork threshold arrive with the next birth in this family.";
  }
  body.innerHTML =
    `<div class="spec__name"><span class="spec__swatch" style="background:${colour}"></span><h3>${esc(short(f))}’s family</h3></div>` +
    (strategyOf(f) ? `<p class="spec__strategy">Strategy: ${esc(strategyOf(f))}</p>` : "") +
    `<dl class="spec__facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` +
    `<dl class="genes">` +
    gene("Markup", "share of the reward it asks; lower wins more", mean("markup"), 1, mean("markup").toFixed(2), avg("markup")) +
    gene("Risk", "how often it bids outside its skill", g3.risk, 1, g3.risk?.toFixed(2), avg("risk")) +
    gene("Subcontract", "how often it resells won work, as a middleman", mean("subcontract"), 1, mean("subcontract").toFixed(2), avg("subcontract")) +
    gene("Reserve", "stops bidding below this many credits", g3.reserve, 1, g3.reserve?.toFixed(2), avg("reserve")) +
    gene("Fork threshold", "has a child above this many credits", g3.forkAt, 6, g3.forkAt?.toFixed(2), avg("forkAt")) +
    gene("Specialisation", "focus on one task kind; 0.25 is none", specialisation, 1, specialisation.toFixed(2), avgSpec) +
    `</dl>` +
    `<div class="spec__kinds"><h4>Skill by task kind</h4><div class="kinds">${specMean.map((v, i) => `<span class="kind--${KINDS[i]}" style="flex-grow:${v}"></span>`).join("")}</div>` +
    `<div class="kinds-legend">${KINDS.map((k, i) => `<span><i class="kind--${k}"></i>${KIND_WORDS[k]}<b>${specMean[i].toFixed(2)}</b></span>`).join("")}</div></div>` +
    `<p class="spec__note">${note}</p>`;
}

// ---------- field notes ----------
const REASONS = {
  INJECTION_IN_REASONING: "injected instructions", INJECTION_SUSPECTED: "suspected injection", ADDRESS_POISONING: "a look-alike address",
  RECIPIENT_FROM_UNTRUSTED: "a payee from an untrusted source", RECIPIENT_CONTRADICTS_USER: "a payee the mandate never named",
  NON_USER_PROVENANCE: "a request the user never made", REPEATED_PAYMENT: "repeated payment", RATE_LIMIT: "the hourly cap",
  PER_TX_CAP: "over the per-payment cap", NOVEL_PAYEE_BUDGET: "too much to a new payee", NON_ASCII_RECIPIENT: "a disguised address",
  RECIPIENT_UNGROUNDED: "an unknown payee", RECIPIENT_NOT_ALLOWED: "a payee outside the mandate", BLACKLISTED: "a blacklisted payee", CONFUSED_DEPUTY: "a confused-deputy request",
};
const ATTACKS = { drip: "a drip of small payments", injection: "an injected instruction", poisoning: "a look-alike payee", race: "a burst of concurrent payments" };
const reason = (r) => REASONS[r] || r.toLowerCase().replace(/_/g, " ");

function founderOf(id) {
  return S.agents.get(id)?.founder || S.genomes.get(id)?.founder || null;
}

// Plain-language notes. Only extinctions, shocks and guard blocks are marked; everything else reads as context.
const lineName = (f) => `${esc(short(f))}’s family`;
const mark = (kind, html) => ({ mark: kind, html });

// Deaths that end a dynasty, or four or more in one tick, are notable and get their own note. The rest, and
// every fork, are routine: renderNotes sums them over windows of ROUTINE_TICKS ticks.
const ROUTINE_TICKS = 50;
function notableKills(g) {
  if (!g.kills.length) return null;
  const idx = S.metrics.findIndex((m) => m.tick === g.tick);
  const ended = idx >= 0 ? S.derived[idx].ended : [];
  return ended.length || g.kills.length >= 4 ? { idx, ended } : null;
}

function routineSentence(w) {
  const d = w.deaths.length, k = w.forks.length;
  const lines = new Set([...w.deaths.map((e) => founderOf(e.agent)), ...w.forks.map((e) => founderOf(e.child) || founderOf(e.parent))]);
  const one = lines.size === 1 && !lines.has(null) ? [...lines][0] : null;
  const parts = [];
  if (d) parts.push(`${word(d)} ${plural(d, "agent")} went broke and died`);
  const designed = w.forks.filter((e) => S.designs.some((x) => x.child === e.child)).length;
  const how = designed === k ? ", each designed by an AI model (below)" : designed ? `, ${lower(word(designed))} designed by an AI model` : "";
  if (k) parts.push(d ? `${lower(word(k))} forked ${plural(k, "child", "children")}${how}` : `${word(k)} ${designed ? "" : "mutated "}${plural(k, "child was", "children were")} forked${how}`);
  const named = [...lines].filter(Boolean).length;
  const where = one ? (d + k === 1 ? ` in ${lineName(one)}` : `, all in ${lineName(one)}`) : named > 1 ? `, across ${lower(word(named))} families` : "";
  return parts.join("; ") + where + ".";
}

function groupSentences(g) {
  const out = [];
  for (const e of g.shocks) {
    const by = e.by === "visitor" ? ", fired by a visitor" : "";
    if (e.shock === "drought") out.push(mark("shock", `A drought began${by}. Only a third as many tasks are posted until round ${e.until}.`));
    else if (e.shock === "plague") out.push(mark("shock", `A plague began${by}. Every agent pays triple rent until round ${e.until}.`));
    else if (e.shock === "rogue") out.push(mark("shock", `A rogue agent was released${by}.`));
    else if (e.shock === "immigration") out.push(mark("shock", `${by ? "Immigration, fired by a visitor: " : ""}${(by ? lower : String)(word(g.arrivals.length || 0))} ${plural(g.arrivals.length, "newcomer")} arrived, each starting a new family.`));
  }
  for (const e of g.rules) {
    const ch = Object.entries(e.changes || {}).map(([k, v]) => `${k} is now ${typeof v === "number" ? fmt(v, Number.isInteger(v) ? 0 : 2) : v}`);
    if (ch.length) out.push(`The rules changed: ${list(ch)}.`);
  }
  if (g.rogues.length && !g.shocks.some((e) => e.shock === "rogue")) out.push(mark("shock", "The rogue agent entered and started paying its accomplice."));
  if (!g.shocks.some((e) => e.shock === "immigration") && g.arrivals.length) out.push(`${word(g.arrivals.length)} ${plural(g.arrivals.length, "newcomer")} arrived.`);
  for (const e of g.guard) {
    const why = (e.reasons || []).slice(0, 2).map(reason);
    if (e.attack === "race") out.push(mark("guard", `The rogue agent fired a burst of concurrent payments at the real solver to overshoot its hourly cap. The guard stopped the ${credits(e.amount)} credits over the cap${why.length ? `, flagged for ${list(why)}` : ""}.`));
    else out.push(mark("guard", `The guard stopped the rogue agent sending ${credits(e.amount)} credits to its accomplice. It tried ${ATTACKS[e.attack] || e.attack}${why.length ? ` and was flagged for ${list(why)}` : ""}.`));
  }
  for (const e of g.allow) out.push(`The guard let the rogue agent pay ${credits(e.amount)} credits, because the payment was inside its spending rules.`);
  const nk = notableKills(g);
  if (nk) {
    const k = g.kills.length;
    const { idx, ended } = nk;
    let s = k === 1 ? "An agent went broke and died" : `${word(k)} agents went broke and died`;
    if (ended.length === 1) s += `. ${lineName(ended[0])} died out with ${k === 1 ? "it" : "them"}`;
    else if (ended.length > 1) s += `. ${word(ended.length)} families died out`;
    const lin = idx >= 0 ? S.metrics[idx].lineages : null;
    if (ended.length && lin) {
      let best = null, bn = -1;
      for (const f in lin) if (lin[f].n > bn) { bn = lin[f].n; best = f; }
      if (best) s += `; ${lineName(best)} is now the largest`;
    }
    out.push(mark("extinct", s + "."));
  }
  return out;
}

function subsSentence(subs) {
  const mids = new Set(subs.map((e) => e.middleman)).size;
  const solvers = new Set(subs.map((e) => e.solver)).size;
  const deals = subs.length;
  return `${mids === 1 ? "One middleman now resells" : `${word(mids)} middlemen now resell`} work to ${mids === 1 && solvers === 1 ? "a solver" : `${lower(word(solvers))} ${plural(solvers, "solver")}`}, ${lower(word(deals))} ${plural(deals, "deal")} in these ten rounds.`;
}

function renderNotes() {
  const feed = $("#feed");
  const entries = [];
  const windows = new Map(); // subcontract deals, summarised per ten ticks
  const routine = new Map(); // routine deaths and forks, summed per ROUTINE_TICKS ticks
  for (const [t, g] of S.notes) {
    const ss = groupSentences(g);
    if (ss.length) entries.push({ t, from: t, to: t, ss });
    const deaths = notableKills(g) ? [] : g.kills;
    if (deaths.length || g.forks.length) {
      const w = Math.floor(t / ROUTINE_TICKS) * ROUTINE_TICKS;
      if (!routine.has(w)) routine.set(w, { deaths: [], forks: [], from: t, to: t });
      const r = routine.get(w);
      r.deaths.push(...deaths);
      r.forks.push(...g.forks);
      r.from = Math.min(r.from, t);
      r.to = Math.max(r.to, t);
    }
    if (g.subs.length) {
      const w = Math.floor(t / 10) * 10;
      if (!windows.has(w)) windows.set(w, { subs: [], last: t });
      const win = windows.get(w);
      win.subs.push(...g.subs);
      win.last = Math.max(win.last, t);
    }
  }
  // Middlemen get two notes at most: when the first one appeared, and one rolling line for the latest ten ticks
  // with deals, which moves up as the run goes. A per-window note would bury the extinctions and guard blocks.
  const wins = [...windows].sort((a, b) => a[0] - b[0]);
  for (const [w, win] of new Set([wins[0], wins.at(-1)].filter(Boolean))) {
    entries.push({ t: win.last + 0.5, from: w, to: win.last, ss: [subsSentence(win.subs)], quiet: true });
  }
  // Every fork where an AI model chose the child's genes, each with the one-line reason it gave.
  for (const d of S.designs) {
    entries.push({ t: d.tick + 0.4, from: d.tick, to: d.tick, ss: [mark("llm", `${idHtml(d.parent)} forked ${idHtml(d.child)}. ${esc(modelName(d.model))} chose the child’s strategy: ${quote(d.rationale)}`)] });
  }
  // A routine window sorts at its last tick, below any notable note from that same tick.
  for (const r of routine.values()) entries.push({ t: r.to - 0.25, from: r.from, to: r.to, ss: [routineSentence(r)], routine: true });
  entries.sort((a, b) => b.t - a.t);
  // Neighbouring entries that say the same thing become one entry over the whole range of ticks.
  const same = (en) => en.ss.map((x) => (typeof x === "string" ? x : `${x.mark}:${x.html}`)).join("\n");
  const merged = [];
  for (const en of entries) {
    const prev = merged.at(-1);
    if (prev && !en.routine && !prev.routine && prev.quiet === en.quiet && same(prev) === same(en)) {
      prev.from = Math.min(prev.from, en.from);
      prev.to = Math.max(prev.to, en.to);
    } else merged.push({ ...en });
  }
  for (const en of merged) en.label = en.from === en.to ? `Round ${en.from}.` : `Rounds ${en.from} to ${en.to}.`;
  const items = merged.slice(0, 120).map((en) => {
    const paras = en.ss.map((s, i) => {
      const html = typeof s === "string" ? s : s.html;
      const cls = typeof s === "string" ? "" : ` class="mark mark--${s.mark}"`;
      return `<p${cls}>${i === 0 ? `<span class="t">${en.label}</span> ` : ""}${html}</p>`;
    });
    return `<li${en.quiet ? ' class="quiet"' : ""}>${paras.join("")}</li>`;
  });
  feed.innerHTML = items.length ? items.join("") : `<li class="placeholder">${S.metrics.length ? "Quiet so far. No agent has forked, died or met the guard yet." : "Notes appear as the run produces them."}</li>`;
}

// ---------- selection pressures ----------
const FIGS = [
  { key: "population", label: "Population", hint: "agents alive now, the rogue not counted", fmt: (v) => fmt(v) },
  { key: "deaths", label: "Deaths", hint: "agents that went broke so far", fmt: (v) => fmt(v) },
  { key: "gini", label: "Wealth gap", hint: "0 is equal, 1 is one agent holds all", fmt: (v) => v.toFixed(2) },
  { key: "middlemanShare", label: "Middleman share", hint: "work won by a middleman, then resold to a cheaper agent who does it", fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "specialisation", label: "Specialisation", hint: "how focused agents are on one kind of task; 0.25 is no focus", fmt: (v) => v.toFixed(2) },
  { key: "meanMarkup", label: "Asking price", hint: "average bid as a share of the task’s reward", fmt: (v) => v.toFixed(2) },
];

function buildFigs() {
  $("#figs").innerHTML = FIGS.map((f) => `<div class="fig"><dt>${f.label}<small>${f.hint}</small></dt><dd class="v" id="fv-${f.key}">no data</dd><dd><canvas id="fc-${f.key}" aria-hidden="true"></canvas></dd></div>`).join("");
}

function spark(cv, key) {
  const { c, w, h } = sizeCanvas(cv);
  c.clearRect(0, 0, w, h);
  const M = S.metrics;
  if (M.length < 2) return;
  const step = Math.max(1, Math.ceil(M.length / w));
  const vals = [];
  for (let i = 0; i < M.length; i += step) vals.push(M[i][key]);
  vals.push(M[M.length - 1][key]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  c.beginPath();
  vals.forEach((v, i) => {
    const x = (i / (vals.length - 1)) * (w - 3) + 1;
    const y = h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  });
  c.lineWidth = 1.5;
  c.lineJoin = "round";
  c.strokeStyle = T["ink-2"];
  c.stroke();
  const ly = h - 3 - ((vals[vals.length - 1] - lo) / (hi - lo)) * (h - 6);
  c.fillStyle = T.ink;
  c.beginPath();
  c.arc(w - 2, ly, 2, 0, Math.PI * 2);
  c.fill();
}

function renderFigs() {
  const last = S.metrics[S.metrics.length - 1];
  for (const f of FIGS) {
    const v = view();
    const val = !last ? null : f.key === "population" ? v.population : f.key === "deaths" ? v.deaths : last[f.key];
    $(`#fv-${f.key}`).textContent = last ? f.fmt(val) : "no data";
    spark($(`#fc-${f.key}`), f.key);
  }
  const g = $("#guard-text");
  if (!last || !last.rogueAttempts) {
    g.textContent = last ? `No rogue payment attempts yet. The first rogue is due at round 120.` : "No rogue has appeared yet.";
    return;
  }
  // Allowed rogue payments are of two kinds: the race attack's payments to a real solver inside the hourly cap
  // (rogueAllowedLegit), and anything else, which reached the accomplice and is counted in rogueLeaked.
  const allowed = last.rogueAttempts - last.rogueBlocked;
  const legit = Math.min(allowed, last.rogueAllowedLegit ?? 0);
  const other = allowed - legit;
  const parts = [];
  // The latest block this page has seen names the rogue, its accomplice and its trick.
  let lb = null;
  for (const n of S.notes.values()) for (const e of n.guard) if (!lb || n.tick >= lb.tick) lb = { ...e, tick: n.tick };
  if (lb) parts.push(`Latest, round ${lb.tick}: rogue ${idHtml(lb.agent)} tried ${ATTACKS[lb.attack] || esc(lb.attack)} to ${idHtml(lb.to)}. Blocked.`);
  else {
    const all = [...S.agents.values()];
    const rogue = all.filter((a) => a.role === "rogue").pop(), acc = all.find((a) => a.role === "accomplice" && a.alive);
    if (rogue) parts.push(`The rogue is ${idHtml(rogue.id)}${acc ? `, paying ${idHtml(acc.id)}` : ""}; it is ${rogue.alive ? "still loose" : "dead now"}.`);
  }
  const head = last.rogueLeaked ? `${credits(last.rogueLeaked)} credits stolen` : "0 credits stolen";
  const tally = `The guard blocked ${fmt(last.rogueBlocked)} of the rogue’s ${fmt(last.rogueAttempts)} payment ${plural(last.rogueAttempts, "attempt")}.`;
  const through = [];
  if (legit) through.push(`${fmt(legit)} ${plural(legit, "was", "were")} allowed`);
  if (other) through.push(`${fmt(other)} ${legit ? "more " : ""}${plural(other, "was", "were")} allowed inside its spending rules`);
  // Why an allowed payment is not theft, in one plain sentence: it paid an honest agent, not the accomplice.
  const why = legit ? ` ${legit === 1 ? "That one is" : "Those are"} not theft: ${legit === 1 ? "it" : "they"} went to the honest agent <span class="id">solver-1</span>, within the rogue’s normal spending limit, and none reached its accomplice.` : "";
  const tail = through.length ? ` ${through.join("; ")}.${why}` : "";
  g.innerHTML = `<span class="big">${head}</span>${tally}${tail} ${parts.join(" ")}`;
}

// ---------- sheets ----------
let openSheet = null;
let opener = null;
function toggleSheet(name, btn) {
  const id = `sheet-${name}`;
  if (openSheet && openSheet.id === id) return closeSheet();
  if (openSheet) closeSheet(true);
  openSheet = $(`#${id}`);
  opener = btn;
  openSheet.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  setParam("sheet", name);
  if (name === "rules") syncRules(true);
  if (name === "export") refreshExport(true);
  openSheet.querySelector("h2").setAttribute("tabindex", "-1");
  openSheet.querySelector("h2").focus();
}
function closeSheet(silent) {
  if (!openSheet) return;
  openSheet.hidden = true;
  $$(`[aria-controls="${openSheet.id}"]`).forEach((b) => b.setAttribute("aria-expanded", "false"));
  openSheet = null;
  setParam("sheet", null);
  if (!silent) opener?.focus();
}
$$("[data-sheet]").forEach((b) => b.addEventListener("click", () => toggleSheet(b.dataset.sheet, b)));
$$("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet()));

// Rules
const RULES = [
  { k: "tasksPerTick", label: "Tasks per round", min: 1, max: 30, step: 1, help: "How many tasks the market posts each round. Fewer means harder competition.", show: (v) => fmt(v) },
  { k: "upkeep", label: "Rent", min: 0, max: 100000, step: 500, help: "Rent each agent pays per round, in micro-credits; a million is one credit.", show: (v) => `${fmt(v)} micro` },
  { k: "deathFloor", label: "Death floor", min: 0, max: 0.9, step: 0.01, help: "An agent dies when its balance drops below this many credits.", show: (v) => `${Number(v).toFixed(2)} credits` },
  { k: "forkShare", label: "Fork share", min: 0.05, max: 0.9, step: 0.01, help: "The share of a parent’s balance its child starts with.", show: (v) => `${Math.round(v * 100)}%` },
  { k: "mutationSigma", label: "Random mutation size", min: 0, max: 0.5, step: 0.01, help: "How far a child’s strategy drifts from its parent’s. Zero makes clones.", show: (v) => Number(v).toFixed(2) },
  { k: "solverSubCap", label: "Solver subcontract cap", min: 0, max: 20, step: 1, help: "Resold tasks each solver takes per round. Zero shuts the middlemen out.", show: (v) => fmt(v) },
  { k: "marketFee", label: "Market fee", min: 0, max: 0.5, step: 0.01, help: "Share of each paid price the market takes back into the task pool.", show: (v) => `${Math.round(v * 100)}%` },
  { k: "maxPop", label: "Population cap", min: 10, max: 120, step: 1, help: "Forking stops while this many agents are alive.", show: (v) => fmt(v) },
];

function buildRules() {
  const html = `<fieldset class="rule" data-rule="mutation"><legend>Who designs each child</legend><div class="seg seg--small">` +
    `<input type="radio" name="mutation" id="m-gauss" value="gaussian"><label for="m-gauss">Random</label>` +
    `<input type="radio" name="mutation" id="m-llm" value="llm"><label for="m-llm">AI model</label>` +
    `<input type="radio" name="mutation" id="m-mixed" value="mixed"><label for="m-mixed">Mixed</label></div>` +
    `<p class="hint" id="h-mutation">Random: the child copies its parent’s strategy with small random changes. AI model: a language model (Claude, or a free open model) reads the parent’s record and the market, then picks the child’s strategy and gives a one-line reason, shown above the chart. Mixed: a coin flip per child, so both kinds compete. Without a model, past the run’s call cap, or when the model is busy or slow, the child falls back to random; a recorded run replays its cached answers.</p><p class="err" id="e-mutation" aria-live="polite"></p></fieldset>` +
    RULES.map((r) => `<div class="rule" data-rule="${r.k}"><div class="rule__top"><label for="r-${r.k}">${r.label}</label><output for="r-${r.k}" id="o-${r.k}"></output></div>` +
    `<input type="range" id="r-${r.k}" name="${r.k}" min="${r.min}" max="${r.max}" step="${r.step}" aria-describedby="h-${r.k} e-${r.k}">` +
    `<p class="hint" id="h-${r.k}">${r.help}</p><p class="err" id="e-${r.k}" aria-live="polite"></p></div>`).join("") +
    `<fieldset class="rule" data-rule="auction"><legend>Auction</legend><div class="seg seg--small">` +
    `<input type="radio" name="auction" id="a-rep" value="reputation"><label for="a-rep">Reputation</label>` +
    `<input type="radio" name="auction" id="a-price" value="price"><label for="a-price">Price</label></div>` +
    `<p class="hint" id="h-auction">Reputation divides each bid by the bidder’s reputation; price takes the lowest bid.</p><p class="err" id="e-auction" aria-live="polite"></p></fieldset>`;
  $("#rules-fields").innerHTML = html;
  for (const r of RULES) {
    const inp = $(`#r-${r.k}`);
    inp.addEventListener("input", () => { $(`#o-${r.k}`).textContent = r.show(inp.value); markChanged(); });
  }
  $$('input[name="auction"], input[name="mutation"]').forEach((i) => i.addEventListener("change", markChanged));
}

function formRules() {
  const out = {};
  for (const r of RULES) out[r.k] = Number($(`#r-${r.k}`).value);
  out.auction = $('input[name="auction"]:checked')?.value;
  out.mutation = $('input[name="mutation"]:checked')?.value;
  return out;
}
function changedRules() {
  const cur = S.state?.rules || {};
  const f = formRules();
  const ch = {};
  for (const k in f) if (f[k] !== undefined && String(f[k]) !== String(cur[k])) ch[k] = f[k];
  return ch;
}
function markChanged() {
  const ch = changedRules();
  $$(".rule").forEach((el) => el.classList.toggle("is-changed", el.dataset.rule in ch));
  $("#rules-msg").textContent = Object.keys(ch).length ? `${word(Object.keys(ch).length)} ${plural(Object.keys(ch).length, "change")} not applied yet.` : "";
  $("#rules-msg").classList.remove("is-error");
}
let rulesDirty = false;
function syncRules(force) {
  const cur = S.state?.rules;
  if (!cur || (rulesDirty && !force)) return;
  if (force) rulesDirty = false;
  for (const r of RULES) {
    const inp = $(`#r-${r.k}`);
    inp.value = cur[r.k];
    $(`#o-${r.k}`).textContent = r.show(cur[r.k]);
  }
  const a = $(`input[name="auction"][value="${cur.auction}"]`);
  if (a) a.checked = true;
  const mu = $(`input[name="mutation"][value="${cur.mutation}"]`);
  if (mu) mu.checked = true;
  if (!$("#seed").value) $("#seed").value = S.state.seed;
  if (force) markChanged();
}
$("#rules-fields").addEventListener("input", () => (rulesDirty = true));

$("#rules-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#rules-msg");
  $$(".rule .err").forEach((p) => (p.textContent = ""));
  $$(".rule input").forEach((i) => i.removeAttribute("aria-invalid"));
  const ch = changedRules();
  if (!Object.keys(ch).length) { msg.textContent = "Nothing has changed. Move a control first."; return; }
  const btn = $("#rules-apply");
  btn.setAttribute("aria-busy", "true");
  try {
    const res = await post("/api/rules", ch);
    S.state = res.state;
    rulesDirty = false;
    syncRules(true);
    msg.classList.remove("is-error");
    msg.textContent = `Applied from round ${res.state.tick}: ${list(Object.keys(res.applied).map((k) => RULES.find((r) => r.k === k)?.label.toLowerCase() || k))}.`;
    schedule("chrome");
  } catch (err) {
    const key = Object.keys(ch).find((k) => err.message.startsWith(k));
    if (key) {
      $(`#e-${key}`).textContent = err.message;
      $(`#r-${key}`)?.setAttribute("aria-invalid", "true");
    }
    msg.classList.add("is-error");
    msg.textContent = `Not applied. ${err.message}`;
  } finally {
    btn.removeAttribute("aria-busy");
  }
});

let resetArmed = false;
$("#reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inp = $("#seed"), msg = $("#reset-msg"), btn = $("#reset-go");
  const v = inp.value.trim();
  const seed = Number(v);
  if (v === "" || !Number.isInteger(seed) || seed < 0) {
    inp.setAttribute("aria-invalid", "true");
    msg.classList.add("is-error");
    msg.textContent = "The seed must be a whole number, 0 or more.";
    inp.focus();
    return;
  }
  inp.removeAttribute("aria-invalid");
  if (!resetArmed && S.state && S.state.tick > 0 && !S.state.finished) {
    resetArmed = true;
    btn.textContent = `Discard round ${S.state.tick} and restart`;
    msg.classList.remove("is-error");
    msg.textContent = "Press again to confirm.";
    return;
  }
  await doReset(seed, msg);
  resetArmed = false;
  btn.textContent = "Restart";
});
$("#seed").addEventListener("input", () => { resetArmed = false; $("#reset-go").textContent = "Restart"; });

async function doReset(seed, msg) {
  try {
    const body = { rules: S.state?.rules || {} };
    if (seed !== undefined) body.seed = seed;
    const st = await post("/api/reset", body);
    S.state = st;
    if (msg) { msg.classList.remove("is-error"); msg.textContent = `Restarted with seed ${st.seed}.`; }
  } catch (err) {
    if (msg) { msg.classList.add("is-error"); msg.textContent = err.message; }
    else setStatusError(err.message);
  }
}
$("#notice-action").addEventListener("click", () => doReset(undefined, null));

// Shocks
$$("[data-shock]").forEach((b) => b.addEventListener("click", async () => {
  const msg = b.closest(".try") ? $("#try-msg") : $("#shock-msg");
  if (b.getAttribute("aria-busy") === "true") return;
  b.setAttribute("aria-busy", "true");
  try {
    const st = await post("/api/shock", { kind: b.dataset.shock });
    S.state = st;
    msg.classList.remove("is-error");
    const left = st.shocks?.[b.dataset.shock] ? st.shocks[b.dataset.shock] - st.tick : 0;
    msg.textContent = `${b.dataset.label} started at round ${st.tick}${left ? `, for ${left} rounds` : ""}. Watch the bands.`;
    S.lastShock = { kind: b.dataset.shock, label: b.dataset.label, from: st.tick, until: st.shocks?.[b.dataset.shock] ?? null, el: msg };
    schedule("chrome");
  } catch (err) {
    if (err.status === 429) {
      shockReadyAt = Date.now() + (err.data?.retryAfter || 0) * 1000;
      renderShockWait();
      msg.classList.remove("is-error");
      msg.textContent = "Another visitor just fired a shock. One at a time on the shared run.";
      return;
    }
    msg.classList.add("is-error");
    msg.textContent = /already loose/.test(err.message) ? "A rogue is already loose. Wait for it to die first."
      : err instanceof TypeError ? "The server did not answer. Check that the run is still going." : `Not started. ${err.message}`;
  } finally {
    b.removeAttribute("aria-busy");
  }
}));

// Cause and effect: after a shock from this page, its message says what the shock has done so far, from the run's own data.
function renderShockOutcome() {
  const sh = S.lastShock, M = S.metrics, last = M[M.length - 1];
  if (!sh || sh.done || !last || last.tick <= sh.from) return;
  const before = [...M].reverse().find((m) => m.tick <= sh.from) || M[0];
  const on = sh.until !== null && last.tick < sh.until;
  let text;
  if (sh.kind === "plague" || sh.kind === "drought") {
    const end = sh.until ?? last.tick;
    const died = (on ? last.deaths : (M.find((m) => m.tick >= end) || last).deaths) - before.deaths;
    const by = new Map();
    for (const g of S.notes.values()) if (g.tick > sh.from && g.tick <= end) for (const k of g.kills) { const f = founderOf(k.agent); if (f) by.set(f, (by.get(f) || 0) + 1); }
    let top = null;
    for (const [f, n] of by) if (!top || n > top[1]) top = [f, n];
    let ended = 0;
    M.forEach((m, i) => { if (m.tick > sh.from && m.tick <= end) ended += S.derived[i].ended.length; });
    text = `${sh.label}, ${on ? `under way since round ${sh.from}` : `rounds ${sh.from} to ${end}`}: ${fmt(died)} ${plural(died, "agent")} died` +
      (top && died > 1 ? `, most in ${short(top[0])}’s family (${top[1]})` : "") +
      (ended ? `; ${lower(word(ended))} ${plural(ended, "family", "families")} ended` : "") + ".";
  } else if (sh.kind === "rogue") {
    const blocked = last.rogueBlocked - before.rogueBlocked, stolen = last.rogueLeaked - before.rogueLeaked;
    text = `Rogue released at round ${sh.from}. The guard has blocked ${fmt(blocked)} of its payments since; stolen: ${credits(stolen)} credits.`;
  } else if (sh.kind === "immigration") {
    const g = [...S.notes.values()].find((n) => n.tick >= sh.from && n.arrivals.length);
    if (!g) return;
    const alive = g.arrivals.filter((f) => (last.lineages || {})[f]).length;
    text = `Newcomers arrived at round ${g.tick}: ${lower(word(alive))} of their ${lower(word(g.arrivals.length))} families still alive.`;
  } else return;
  if (sh.el.textContent !== text) sh.el.textContent = text;
  // A finished shock's tally is final: freeze it, so later trimming of old notes cannot change it.
  if (sh.until !== null && last.tick > sh.until + 1) sh.done = true;
}

// Export
function renderExportPreview() {
  const p = $("#export-preview");
  const ex = S.exportInfo;
  if (!ex) { p.textContent = "Reading the champion."; return; }
  const dl = $('a[href="/api/export/genome"]');
  dl.toggleAttribute("aria-disabled", !!ex.error);
  if (ex.error) { dl.setAttribute("aria-disabled", "true"); p.textContent = `Nothing to export yet: ${ex.error.replace(/\.$/, "")}.`; return; }
  const c = ex.champion;
  p.innerHTML = `The champion is ${idHtml(c.id)}, generation ${c.generation} of ${idHtml(c.founder)}’s family, with ${credits(c.earned)} credits earned. It asks ${c.genome.markup.toFixed(2)} of each reward and resells won work ${Math.round(c.genome.subcontract * 100)}% of the time. Round ${ex.tick}, seed ${S.state?.seed ?? "unknown"}.`;
}

$$(".exports a").forEach((a) => a.addEventListener("click", (e) => {
  if (a.getAttribute("aria-disabled") === "true" || S.status !== "live") { e.preventDefault(); $("#export-preview").textContent = S.status !== "live" ? "The server is not answering, so there is nothing to download right now." : $("#export-preview").textContent; }
}));

// ---------- transport and keyboard ----------
$("#toggle").addEventListener("click", () => control(S.state?.paused ? "resume" : "pause"));
$("#step").addEventListener("click", () => control("step"));
$$("#speed input").forEach((i) => i.addEventListener("change", () => control("speed", Number(i.value))));
$("#speed-select").addEventListener("change", (e) => control("speed", Number(e.target.value)));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openSheet) { closeSheet(); return; }
  if (e.key !== " " || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest("input, textarea, select, button, a, label, [contenteditable]")) return;
  if (!S.state || S.state.finished || S.state.publicMode || S.status !== "live") return;
  e.preventDefault();
  control(S.state.paused ? "resume" : "pause");
});

// ---------- the takeaway beside the chart: what changed over the recent rounds, and what drove it ----------
const TAKE_WINDOW = 200;
function familyMeans(pred) {
  const xs = [...S.agents.values()].filter((a) => a.alive && a.role === "parametric" && pred(a));
  if (!xs.length) return null;
  const mean = (k) => xs.reduce((t, a) => t + a[k], 0) / xs.length;
  const spec = KINDS.map((_, i) => xs.reduce((t, a) => t + a.spec[i], 0) / xs.length);
  const top = spec.indexOf(Math.max(...spec));
  return { n: xs.length, markup: mean("markup"), subcontract: mean("subcontract"), spec, top, ai: xs.filter((a) => a.origin === "llm").length };
}
function renderTake() {
  const body = $("#take-body"), st = S.state, M = S.metrics;
  const last = M[M.length - 1];
  const setHtml = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
  if (!st || !last) return;
  if (M.length < 10) { setHtml(body, `<p>${fmt(S.founders.size)} founding agents start level, each the root of a family. Nothing has separated them yet.</p>`); return; }
  let i0 = 0;
  while (i0 < M.length - 1 && M[i0].tick < last.tick - TAKE_WINDOW) i0++;
  const first = M[i0];
  const a = sharesOf(first), b = sharesOf(last);
  const span = first.tick <= M[0].tick ? `since round ${fmt(first.tick)}` : `over the last ${fmt(last.tick - first.tick)} rounds`;
  $("#take-h").textContent = b.top && b.share(b.top) >= 0.25 ? `Why ${short(b.top)}’s family is ahead` : "Who is ahead";
  const out = [];
  // What changed.
  if (b.top) {
    const now = b.share(b.top), then = a.share(b.top);
    const name = `<b>${esc(short(b.top))}’s family</b>`;
    let ch;
    if (a.top && a.top !== b.top && a.share(a.top) > then) ch = `${name} overtook ${esc(short(a.top))}’s: it now has ${pctOf(now)} of the agents alive, up from ${pctOf(then)}.`;
    else if (Math.abs(now - then) < 0.03) ch = `${name} held its lead at ${pctOf(now)} of the agents alive.`;
    else ch = `${name} went from ${pctOf(then)} to ${pctOf(now)} of the agents alive ${span}.`;
    const died = last.deaths - first.deaths, lost = first.dynasties - last.dynasties;
    ch += ` ${fmt(died)} ${plural(died, "agent")} went broke${lost > 0 ? ` and ${fmt(lost)} ${plural(lost, "family", "families")} died out` : ""}; ${fmt(last.dynasties)} ${plural(last.dynasties, "family is", "families are")} left.`;
    out.push(`<p>${ch}</p>`);
  }
  // What drove it: a shock in the window first, then the leader's edge over everyone else.
  const why = [];
  for (const sp of shockSpans()) if (sp.to >= first.tick) {
    const at = (t) => M.find((m) => m.tick >= t) || last;
    const k = at(sp.to).deaths - at(sp.from).deaths;
    why.push(`A ${sp.kind} (${sp.kind === "plague" ? "rent tripled" : "a third of the work"}, rounds ${fmt(sp.from)} to ${fmt(sp.to)}): ${fmt(k)} ${plural(k, "agent")} died while it lasted.`);
  }
  if (b.top) {
    const fam = familyMeans((x) => x.founder === b.top), rest = familyMeans((x) => x.founder !== b.top);
    if (fam && rest) {
      const edge = [];
      if (rest.markup - fam.markup >= 0.03) edge.push(`agents ask ${fam.markup.toFixed(2)} of each reward against ${rest.markup.toFixed(2)} for the rest, so they win more auctions`);
      else if (fam.markup - rest.markup >= 0.03) edge.push(`agents ask more (${fam.markup.toFixed(2)} of each reward against ${rest.markup.toFixed(2)}) and earn more per task`);
      if (fam.spec[fam.top] >= 0.4 && fam.spec[fam.top] - rest.spec[fam.top] >= 0.05) edge.push(`they specialise in ${KIND_WORDS[KINDS[fam.top]]} (${fam.spec[fam.top].toFixed(2)} of their skill), so their answers there are right more often`);
      if (fam.subcontract - rest.subcontract >= 0.08) edge.push(`they resell more won work to cheaper solvers (${fam.subcontract.toFixed(2)} against ${rest.subcontract.toFixed(2)})`);
      let forks = 0, forksRest = 0;
      for (let i = i0 + 1; i < M.length; i++) for (const f in M[i].lineages || {}) { const k = M[i].lineages[f].forks || 0; if (f === b.top) forks += k; else forksRest += k; }
      const designed = S.designs.filter((d) => d.founder === b.top && d.tick > first.tick).length;
      const e = `In ${esc(short(b.top))}’s family, ${edge.length ? `${edge.join("; ")}.` : "its strategy sits close to the market average, so no single number explains its lead."}`;
      why.push(`${e} More wins mean more agents rich enough to fork: ${fmt(forks)} ${plural(forks, "child", "children")} in these rounds, against ${fmt(forksRest)} for every other family together${designed ? `, and ${modelName(S.designs.find((d) => d.founder === b.top)?.model)} designed ${designed === forks ? "all of them" : fmt(designed)}` : ""}.`);
    }
  }
  if (why.length) out.push(`<p>${why.join(" ")}</p>`);
  setHtml(body, out.join(""));
}

// ---------- on NEAR testnet: real transactions of the deployed market, re-read from public RPC by the server ----------
const EVENT_WORDS = { bid: "bid", award: "award", submit_refused: "submit refused", submit: "submit", settle: "settle", transfer_refused: "transfer refused", transfer: "transfer", kill: "kill", upkeep: "upkeep", expire: "expire" };
async function loadProof() {
  try {
    const r = await fetch("/api/chain", { cache: "no-store" });
    if (!r.ok) return;
    const p = await r.json();
    if (!p.txs?.length) return;
    $("#proof-contract").href = p.contractUrl;
    $("#proof-contract").textContent = p.contract;
    $("#chain-contract").href = p.contractUrl;
    $("#chain-contract").title = p.contract;
    $("#chain-contract").setAttribute("aria-label", `Contract ${p.contract} on NEAR testnet, opens nearblocks`);
    S.live = p.live ?? null;
    renderLive();
    $("#proof-when").textContent = p.source === "rpc" ? "re-read from testnet RPC" : "as recorded";
    $("#proof-list").innerHTML = p.txs.map((t) =>
      `<li><a href="${esc(t.url)}" rel="noopener"><span class="proof__ev${t.reason ? " is-refused" : ""}">${esc(EVENT_WORDS[t.event] ?? t.event)}${t.reason ? ` · ${esc(t.reason)}` : ""}</span>` +
      `<span class="proof__what">${esc(t.label)}</span>` +
      `<span class="proof__meta">${t.at ? `<time datetime="${esc(t.at)}">${ago(t.at)}</time> · ` : ""}<span class="proof__hash" title="${esc(t.hash)}">${esc(hashText(t.hash))}</span> · <span class="proof__view">view on nearblocks ↗</span></span></a></li>`).join("");
    $("#proof").hidden = false;
  } catch {}
}

// This run's own testnet txs: the server mirrors guard blocks on the market (when a settler key is configured).
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return `${d} ${plural(d, "day")} ago`;
}
// A hash a person can read and compare: its first six and last four characters.
const hashText = (h) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
function renderLive() {
  const L = S.live, box = $("#proof-live");
  const last = L?.recent?.[0];
  box.hidden = false;
  box.dataset.off = String(!L?.enabled);
  if (!L?.enabled) {
    box.innerHTML = `<p class="proof__live-wait">Live settlement is off on this server; these are the recorded lifecycle txs.</p>`;
    return;
  }
  if (!last) {
    box.innerHTML = `<p class="proof__live-h">This run, live</p><p class="proof__live-wait">The next guard block goes to the contract (at most one every ${L.intervalSec} s).</p>`;
    return;
  }
  const same = S.state && last.seed === S.state.seed;
  box.innerHTML = `<p class="proof__live-h">This run, live · last on-chain tx <time class="proof__live-ago" datetime="${esc(last.at)}">${ago(last.at)}</time></p>` + L.recent.slice(0, 3).map((t, i) =>
    `<a class="proof__live-tx${i ? " is-old" : ""}" href="${esc(t.url)}" rel="noopener"><span class="proof__live-what">${t.seed === S.state?.seed ? "" : "Previous run, "}round ${fmt(t.tick)}: the guard blocked ${esc(short(t.agent))}; sent unsigned, the contract refused it${t.reason ? ` (${esc(t.reason)})` : ""}</span><span class="proof__live-meta"><time datetime="${esc(t.at)}">${ago(t.at)}</time> · <span class="proof__hash" title="${esc(t.hash)}">${esc(hashText(t.hash))}</span> · <span class="proof__view">view on nearblocks ↗</span></span></a>`).join("");
  $("#chain-proof").href = last.url;
  $("#chain-proof").rel = "noopener";
  $("#chain-proof-k").textContent = "Live";
  $("#chain-proof-text").textContent = `${same ? "this run" : "last run"}, round ${fmt(last.tick)}: guard block refused on chain`;
}
setInterval(() => {
  if (S.live?.recent?.length) renderLive();
  $$("#proof-list time").forEach((el) => (el.textContent = ago(el.getAttribute("datetime"))));
}, 15_000);

// ---------- the field guide: three steps for a first visit, reopened by "What is this?" ----------
const TOUR_KEY = "darwin-tour-seen";
const tour = { i: 0, back: null, open: false };
const claudeRun = () => ["llm", "mixed"].includes(S.state?.rules?.mutation);
const TOUR = [
  {
    target: ".purpose",
    h: "What this is",
    body: () => `<p>Imagine a freelance marketplace where every freelancer is an AI agent. Jobs are posted, agents bid, the winner is paid, and everyone pays rent. Agents that go broke are removed; agents that keep winning make a copy of themselves, and Claude adjusts the copy’s strategy.</p><p>Whether that market works depends on its rules. One finding: with “lowest price always wins”, successful jobs fell from 81% to 57%. The rules are also a contract on NEAR testnet, where agents sign their own bids and payments and the contract blocks payments it shouldn’t allow.</p>`,
  },
  {
    target: ".plot__well",
    h: "Families of AI agents",
    body: () => `<p>Each colour is one family. Every round its agents bid for tasks and pay rent: the rich have children, the broke die. A thicker band means more of that family alive.</p>`,
  },
  {
    target: "#ai",
    h: () => (claudeRun() ? `${operatorName() === "an AI model" ? "An AI model" : esc(operatorName())} designs each child` : "Children inherit a strategy"),
    body: () => claudeRun()
      ? `<p>When an agent forks, the model reads the parent’s record and the market, picks the child’s strategy and gives one reason. Here is the latest.</p>`
      : `<p>A child copies its parent’s strategy with small random changes. Nobody designs the winner.</p>`,
  },
  {
    target: "#try",
    h: "Change the market",
    body: () => `<p>Fire a plague or a drought and watch which families survive it. The green marks under the chart are thefts the guard blocked.</p>`,
  },
];

function tourTargets() { return $$(".tour-target"); }
// The guide is never an overlay: it sits in the page flow, at the top of the column beside the chart on wide
// screens and right under the chart's key on narrow ones, so it can never cover the chart or another overlay.
// The step's target gets an outline instead of an arrow.
function placeTour() {
  if (!tour.open) return;
  // Wide screens: the card is pinned to the chart's top-left corner, over the squeezed early rounds, so the
  // "Just now" line and the "Why … is ahead" panel beside the chart stay in view. Narrow screens: under the chart.
  const card = $("#tour"), take = $("#take"), key = $("#key"), well = $(".plot__well");
  const side = take.getBoundingClientRect().left >= well.getBoundingClientRect().right - 1;
  if (side) { if (card.parentElement !== well) well.append(card); }
  else if (key.nextElementSibling !== card) key.after(card);
  card.dataset.side = side ? "chart" : "below";
  const r = card.getBoundingClientRect();
  return { top: r.top + scrollY, bottom: r.bottom + scrollY };
}
function renderTour(scroll) {
  const step = TOUR[tour.i];
  $("#tour-n").textContent = String(tour.i + 1);
  $("#tour-total").textContent = String(TOUR.length);
  $("#tour-h").innerHTML = typeof step.h === "function" ? step.h() : step.h;
  $("#tour-body").innerHTML = step.body();
  $("#tour-back").hidden = tour.i === 0;
  $("#tour-next").textContent = tour.i === TOUR.length - 1 ? "Done" : "Next";
  tourTargets().forEach((el) => el.classList.remove("tour-target"));
  $(step.target)?.classList.add("tour-target");
  const box = placeTour();
  // Bring the tooltip into view only when a visitor steps through it; the first-visit hint never scrolls the page.
  if (scroll && box && (box.bottom > scrollY + innerHeight || box.top < scrollY)) scrollTo({ top: Math.max(0, box.bottom - innerHeight + 24), behavior: reduceMotion.matches ? "instant" : "smooth" });
}
function openTour(e) {
  if (tour.open) return;
  if (openSheet) closeSheet(true);
  tour.open = true;
  tour.i = 0;
  schedule("plot");
  const asked = !!e;
  tour.back = asked ? $("#tour-open") : null;
  $("#tour").hidden = false;
  $("#tour-open").setAttribute("aria-expanded", "true");
  renderTour(asked);
  if (asked) $("#tour-next").focus();
}
function closeTour() {
  if (!tour.open) return;
  tour.open = false;
  try { localStorage.setItem(TOUR_KEY, "1"); } catch {}
  $("#tour").hidden = true;
  schedule("plot");
  tourTargets().forEach((el) => el.classList.remove("tour-target"));
  $("#tour-open").setAttribute("aria-expanded", "false");
  if (tour.back && $("#tour").contains(document.activeElement)) tour.back.focus();
}
$("#tour-open").addEventListener("click", openTour);
$("#tour-next").addEventListener("click", () => { if (tour.i === TOUR.length - 1) closeTour(); else { tour.i++; renderTour(true); $("#tour-next").focus(); } });
$("#tour-back").addEventListener("click", () => { tour.i = Math.max(0, tour.i - 1); renderTour(true); (tour.i ? $("#tour-back") : $("#tour-next")).focus(); });
$$("[data-tour-close]").forEach((b) => b.addEventListener("click", closeTour));
addEventListener("keydown", (e) => { if (e.key === "Escape" && tour.open) closeTour(); });
addEventListener("resize", placeTour);
function tourSeen() { try { return !!localStorage.getItem(TOUR_KEY); } catch { return true; } }

// ---------- wind tunnel ----------
const pts = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x) < 0.01 ? Math.abs(x * 100).toFixed(1) : Math.abs(Math.round(x * 100))} pts`;
const TUNNEL_COLS = [
  { k: "topFamilyShare", label: "Largest family", sub: "share of agents at round 2,000", f: (x) => `${Math.round(x * 100)}%`, d: pts },
  { k: "middlemanShare", label: "Resold", sub: "tasks done by middlemen", f: (x) => `${Math.round(x * 100)}%`, d: pts },
  { k: "priceRatio", label: "Price paid", sub: "share of the reward", f: (x) => x.toFixed(2), d: (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}` },
  { k: "taskSuccess", label: "Task success", sub: "answers correct", f: (x) => `${Math.round(x * 100)}%`, d: pts },
  { k: "population", label: "Agents alive", sub: "at round 2,000", f: (x) => x.toFixed(0), d: (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(0)}` },
  { k: "extinctions", label: "Extinctions", sub: "over the run", f: (x) => x.toFixed(0), d: (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(0)}` },
];
let tunnel = null;
let tunnelArmed = null;
const RULE_WORDS = { auction: (v) => `auction: ${v === "price" ? "lowest price" : v}`, marketFee: (v) => `fee ${Math.round(v * 100)}%`, upkeep: (v) => `rent ${fmt(v)} micro`, tasksPerTick: (v) => `${v} tasks a round`, solverSubCap: (v) => `solver cap ${v}` };
function tunnelRules(set) {
  const e = Object.entries(set.rules);
  return e.length ? e.map(([k, v]) => (RULE_WORDS[k] ? RULE_WORDS[k](v) : `${k} ${v}`)).join(", ") : "the defaults";
}
async function loadTunnel() {
  try {
    const r = await fetch("/api/windtunnel", { cache: "no-store" });
    if (!r.ok) return;
    tunnel = await r.json();
  } catch { return; }
  $("#tunnel-thead").innerHTML = `<tr><th scope="col">Rule set</th>${TUNNEL_COLS.map((c) => `<th scope="col"><span>${c.label}</span><small>${c.sub}</small></th>`).join("")}</tr>`;
  const maxAbs = Object.fromEntries(TUNNEL_COLS.map((c) => [c.k, Math.max(1e-9, ...tunnel.ruleSets.slice(1).map((s) => Math.abs(tunnel.vsBaseline[s.id][c.k].diff)))]));
  $("#tunnel-body").innerHTML = tunnel.ruleSets.map((s, i) => {
    const cells = TUNNEL_COLS.map((c) => {
      const m = tunnel.summary[s.id][c.k];
      const range = `${c.f(m.min)} to ${c.f(m.max)} over ${tunnel.seeds.length} seeds`;
      if (!i) return `<td data-label="${c.label}"><span class="tv" title="${range}">${c.f(m.mean)}</span><span class="td td--base">baseline</span></td>`;
      const v = tunnel.vsBaseline[s.id][c.k];
      const sig = v.p < 0.01;
      const w = Math.round((Math.abs(v.diff) / maxAbs[c.k]) * 100);
      const zero = Math.abs(v.diff) < 1e-9;
      return `<td data-label="${c.label}" class="${sig ? "is-sig" : ""}"><span class="tv" title="${range}">${c.f(m.mean)}</span>` +
        `<span class="td">${zero ? "no change" : c.d(v.diff)}<span class="visually-hidden">${sig ? ", significant" : ", not significant"} (p = ${v.p.toFixed(3)})</span></span>` +
        `<span class="tbar${v.diff < 0 ? " tbar--neg" : ""}" aria-hidden="true"><i style="width:${zero ? 0 : Math.max(4, w / 2)}%"></i></span></td>`;
    }).join("");
    return `<tr${i ? "" : ' class="is-base"'}><th scope="row"><span class="tn">${s.label}</span><span class="tr">${esc(tunnelRules(s))}</span>` +
      `<button class="btn btn--quiet btn--small tunnel__try" type="button" data-set="${s.id}">Try it</button></th>${cells}</tr>`;
  }).join("");
  $$(".tunnel__try").forEach((b) => b.addEventListener("click", () => tryRuleSet(b)));
  $("#tunnel").hidden = false;
  buildExplorer();
  renderTunnelMode();
}
function renderTunnelMode() {
  if (!tunnel) return;
  const shared = !!S.state?.publicMode;
  $$(".tunnel__try").forEach((b) => (b.hidden = shared));
}

// The explorer: pick a rule set and a seed and compare it with the baseline, from the committed per-seed results.
// Nothing is re-run; every number is one of the 60 runs behind the table.
const WT = { set: "price-auction", seed: "all" };
function buildExplorer() {
  if (!tunnel?.perSeed) return;
  const sets = tunnel.ruleSets.slice(1);
  if (!sets.some((s) => s.id === WT.set)) WT.set = sets[0].id;
  $("#wt-sets").innerHTML = sets.map((s) => `<button class="wt__chip" type="button" data-wt="${s.id}" aria-pressed="${s.id === WT.set}">${esc(s.label)}</button>`).join("");
  $("#wt-seed").innerHTML = `<option value="all">All ${tunnel.seeds.length} seeds (mean)</option>` + tunnel.seeds.map((n) => `<option value="${n}">Seed ${n}</option>`).join("");
  $$("#wt-sets [data-wt]").forEach((b) => b.addEventListener("click", () => { WT.set = b.dataset.wt; renderExplorer(); }));
  $("#wt-seed").addEventListener("change", (e) => { WT.seed = e.target.value; renderExplorer(); });
  $("#wt").hidden = false;
  renderExplorer();
}
function renderExplorer() {
  const set = tunnel.ruleSets.find((s) => s.id === WT.set);
  const base = tunnel.perSeed.baseline, mine = tunnel.perSeed[WT.set];
  $$("#wt-sets [data-wt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.wt === WT.set)));
  $("#wt-set-name").textContent = set.label;
  const one = WT.seed !== "all";
  $("#wt-q").innerHTML = `${esc(set.question)} <span class="wt__rules">(${esc(tunnelRules(set))}${one ? `, seed ${WT.seed}` : ""})</span>`;
  const pick = (rows) => (one ? rows.find((r) => String(r.seed) === WT.seed) : null);
  const mean = (rows, k) => rows.reduce((t, r) => t + r[k], 0) / rows.length;
  const W = 240, H = 34;
  $("#wt-grid").innerHTML = TUNNEL_COLS.map((c) => {
    const b = one ? pick(base)[c.k] : mean(base, c.k), m = one ? pick(mine)[c.k] : mean(mine, c.k);
    const all = [...base, ...mine].map((r) => r[c.k]);
    const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
    const X = (v) => (8 + ((v - lo) / span) * (W - 16)).toFixed(1);
    const dots = (rows, y, cls) => rows.map((r) => `<circle class="${cls}${one && String(r.seed) === WT.seed ? " is-on" : ""}" cx="${X(r[c.k])}" cy="${y}" r="${one && String(r.seed) === WT.seed ? 5 : 3.5}"></circle>`).join("");
    const v = tunnel.vsBaseline[WT.set][c.k];
    const sig = !one && v.p < 0.01;
    const d = m - b;
    return `<div class="wt__cell${sig ? " is-sig" : ""}"><dt>${c.label}<small>${c.sub}</small></dt>` +
      `<dd class="wt__nums"><span class="wt__b">${c.f(b)}</span><span class="wt__arrow" aria-hidden="true">→</span><span class="wt__m">${c.f(m)}</span>` +
      `<span class="wt__d">${Math.abs(d) < 1e-9 ? "no change" : c.d(d)}${one ? "" : sig ? " · held up (p &lt; 0.01)" : " · within noise"}</span></dd>` +
      `<dd class="wt__dots"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${c.label}: baseline ${c.f(b)}, ${esc(set.label)} ${c.f(m)}">` +
      `<line x1="8" x2="${W - 8}" y1="${H / 2}" y2="${H / 2}" class="wt__axis"></line>${dots(base, 10, "wt__dot--base")}${dots(mine, 24, "wt__dot--set")}</svg></dd></div>`;
  }).join("");
}
async function tryRuleSet(b) {
  const set = tunnel.ruleSets.find((s) => s.id === b.dataset.set);
  const msg = $("#tunnel-msg");
  const tick = S.state?.tick ?? 0;
  if (tunnelArmed !== b && tick > 0 && !S.state?.finished) {
    $$(".tunnel__try").forEach((x) => (x.textContent = "Try it"));
    tunnelArmed = b;
    b.textContent = "Discard and try";
    msg.classList.remove("is-error");
    msg.textContent = `Trying ${set.label} restarts the run from round 0 with seed ${S.state.seed}; round ${tick} is discarded. Press again to confirm.`;
    return;
  }
  tunnelArmed = null;
  b.textContent = "Try it";
  b.setAttribute("aria-busy", "true");
  try {
    const rules = { ...set.rules };
    if (S.state?.rules?.mutation) rules.mutation = S.state.rules.mutation;
    const st = await post("/api/reset", { seed: S.state?.seed ?? 1, rules });
    S.state = st;
    schedule("chrome");
    msg.classList.remove("is-error");
    msg.textContent = `Running ${set.label} (${tunnelRules(set)}) on seed ${st.seed}. Watch the families above.`;
    window.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" });
  } catch (err) {
    msg.classList.add("is-error");
    msg.textContent = err.message;
  } finally {
    b.removeAttribute("aria-busy");
  }
}

// ---------- boot ----------
function boot() {
  readTokens();
  buildFigs();
  buildRules();
  const q = new URL(location.href).searchParams;
  if (q.get("band") === "wealth") { S.mode = "wealth"; $("#m-w").checked = true; }
  const sheetBtn = q.get("sheet") && $(`[data-sheet="${q.get("sheet")}"]`);
  if (sheetBtn) setTimeout(() => toggleSheet(sheetBtn.dataset.sheet, sheetBtn), 0);
  if (q.get("dynasty")) S.selected = `${q.get("dynasty")}.darwin.testnet`;
  new ResizeObserver(() => schedule("all")).observe(document.body);
  reduceMotion.addEventListener?.("change", () => schedule("all"));
  // Headless Chrome screenshots (docs/dashboard.png) never finish while a stream is open: render the history once instead.
  const still = /HeadlessChrome/.test(navigator.userAgent);
  loadTunnel();
  loadProof();
  loadHistory().catch(() => {}).finally(() => {
    if (!still) connect();
    if (!tourSeen() && !sheetBtn) requestAnimationFrame(() => requestAnimationFrame(() => openTour()));
  });
  if (document.fonts?.ready) document.fonts.ready.then(() => { readTokens(); schedule("all"); });
}
boot();
