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
}

// ---------- state ----------
const S = {
  state: null,
  metrics: [],
  snap: null,
  agents: new Map(), // id -> latest snapshot agent
  genomes: new Map(), // id -> full genome from "born" events
  founders: new Map(), // founder -> { idx, first }
  derived: [], // per metrics index: { ended: [founders], deaths, blocked, leaked }
  notes: new Map(), // tick -> group
  shockMarks: [], // instant shocks { tick, kind }
  exportInfo: null,
  exportTick: -1,
  selected: null,
  mode: "n",
  hover: null,
  status: "loading", // loading | live | disconnected
  tickError: null,
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
const list = (xs) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

// Dynasties whose share never passes this are pooled into one muted band on the plot.
const OTHER = "__other";
const MINOR_PEAK = 0.03;

function colourOf(f) {
  if (f === OTHER) return T.other;
  const rec = S.founders.get(f);
  if (!rec || !T.pigments.length) return T.muted;
  return T.pigments[rec.idx % T.pigments.length];
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
  S.notes.clear();
  S.shockMarks = [];
  S.exportInfo = null;
  S.exportTick = -1;
  S.hover = null;
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
}

function connect() {
  clearTimeout(retryTimer);
  es?.close();
  es = new EventSource("/stream");
  let opened = false;
  es.addEventListener("open", async () => {
    const wasDown = S.status !== "live";
    opened = true;
    if (wasDown) {
      try { await loadHistory(); } catch { /* the stream’s own events will fill in */ }
    }
  });
  es.addEventListener("state", (e) => {
    S.state = JSON.parse(e.data);
    schedule("chrome");
  });
  es.addEventListener("snapshot", (e) => {
    ingestSnapshot(JSON.parse(e.data));
    if (S.status === "loading") S.status = "live";
    schedule("all");
  });
  es.addEventListener("ev", (e) => {
    ingestEvent(JSON.parse(e.data));
    schedule("notes");
  });
  es.addEventListener("reset", async (e) => {
    S.state = JSON.parse(e.data);
    S.selected = null;
    clearAll();
    schedule("all");
    try { await loadHistory(); } catch {}
  });
  es.addEventListener("error", (e) => {
    if (e.data) {
      // A tick failed on the server; the server paused the run.
      try { S.tickError = JSON.parse(e.data).message; } catch { S.tickError = String(e.data); }
      schedule("chrome");
      return;
    }
    S.status = "disconnected";
    schedule("chrome");
    if (es.readyState === EventSource.CLOSED || !opened) {
      es.close();
      retryTimer = setTimeout(connect, 3000);
    }
  });
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || `The server answered ${r.status}.`);
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
  if (dirty.has("figs")) renderFigs();
  if (dirty.has("plot") && S.metrics.length) refreshExport(false);
  dirty.clear();
}

// ---------- chrome: status, transport, notices ----------
const SPEED_WORDS = ["slow", "normal", "fast", "fastest"];
let statusErr = null;
let statusErrTimer = 0;
function setStatusError(msg) {
  statusErr = msg;
  clearTimeout(statusErrTimer);
  statusErrTimer = setTimeout(() => { statusErr = null; renderChrome(); }, 5000);
  renderChrome();
}

function renderChrome() {
  const st = S.state;
  const status = $("#status");
  const toggle = $("#toggle");
  const step = $("#step");
  const notice = $("#notice");
  const noticeText = $("#notice-text");
  const noticeAction = $("#notice-action");

  if (S.status === "disconnected") {
    status.textContent = "Disconnected";
    toggle.disabled = true;
    step.hidden = true;
    notice.hidden = false;
    noticeText.innerHTML = "The DARWIN server stopped. Run <code>make demo</code> to start it again; this page reconnects on its own.";
    noticeAction.hidden = true;
    $$("#speed input").forEach((i) => (i.disabled = true));
    $("#speed-select").disabled = true;
    return;
  }
  if (!st) return;
  $$("#speed input").forEach((i) => {
    i.disabled = false;
    i.checked = Number(i.value) === st.speed;
  });
  const sel = $("#speed-select");
  sel.disabled = false;
  if (st.speed in SPEED_WORDS) sel.value = String(st.speed);

  const parts = [];
  if (st.finished) parts.push(`Finished, tick <b class="num">${fmt(st.tick)}</b> of ${fmt(st.maxTicks)}`);
  else if (st.paused) parts.push(`Paused at tick <b class="num">${fmt(st.tick)}</b> of ${fmt(st.maxTicks)}`);
  else parts.push(`Running at ${SPEED_WORDS[st.speed] ?? "custom"} speed, tick <b class="num">${fmt(st.tick)}</b> of ${fmt(st.maxTicks)}`);
  status.title = `Seed ${st.seed}`;
  const shocks = Object.entries(st.shocks || {}).filter(([, end]) => end > st.tick);
  for (const [k, end] of shocks) parts.push(`<span class="shock">${k === "drought" ? "Drought" : "Plague"}, ${end - st.tick} ${plural(end - st.tick, "tick")} left</span>`);
  let html = parts.join(". ") + ".";
  if (statusErr) html += ` <span class="shock">${esc(statusErr)}</span>`;
  status.innerHTML = html;

  toggle.disabled = st.finished;
  toggle.textContent = st.paused ? "Resume" : "Pause";
  toggle.setAttribute("aria-pressed", String(!st.paused));
  step.hidden = !st.paused || st.finished;

  $("#tick").textContent = fmt(st.tick);
  $("#tick-of").textContent = `of ${fmt(st.maxTicks)} ticks`;

  if (S.tickError) {
    notice.hidden = false;
    noticeText.textContent = `A tick failed on the server and the run paused: ${S.tickError}`;
    noticeAction.hidden = true;
  } else if (st.finished) {
    notice.hidden = false;
    noticeText.textContent = `The run finished at tick ${fmt(st.tick)}. Export the champion, or start a new run with the same rules.`;
    noticeAction.hidden = false;
  } else notice.hidden = true;

  if ($("#sheet-rules").hidden === false) syncRules(false);
}

// ---------- the Muller plot ----------
const plot = $("#plot");
const canvas = $("#muller");
const ctx = canvas.getContext("2d");
const shockCv = $("#shock-lane");
const guardCv = $("#guard-lane");
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
  // Peak share per dynasty over the whole run; the ones that never matter share the "other" band.
  const peak = new Map();
  for (const m of M) {
    const lin = m.lineages || {};
    let total = 0;
    for (const f in lin) total += valueOf(lin[f], S.mode);
    if (total) for (const f in lin) peak.set(f, Math.max(peak.get(f) || 0, valueOf(lin[f], S.mode) / total));
  }
  const minor = new Set([...S.founders.keys()].filter((f) => (peak.get(f) || 0) < MINOR_PEAK));
  const order = [...S.founders.entries()].filter(([f]) => !minor.has(f)).sort((a, b) => a[1].idx - b[1].idx).map(([f]) => f);
  if (minor.size) order.push(OTHER);
  const bands = new Map(order.map((f) => [f, { y0: new Float32Array(samples.length), y1: new Float32Array(samples.length), first: -1, last: -1 }]));
  const others = new Float64Array(samples.length);
  const otherCount = new Uint16Array(samples.length);
  samples.forEach((mi, si) => {
    const lin = M[mi].lineages || {};
    let total = 0;
    for (const f in lin) {
      total += valueOf(lin[f], S.mode);
      if (minor.has(f)) { others[si] += valueOf(lin[f], S.mode); otherCount[si]++; }
    }
    let cum = 0;
    for (const f of order) {
      const b = bands.get(f);
      const here = f === OTHER ? otherCount[si] > 0 : !!lin[f];
      const v = f === OTHER ? others[si] : here ? valueOf(lin[f], S.mode) : 0;
      b.y0[si] = total ? cum / total : 0;
      cum += v;
      b.y1[si] = total ? cum / total : 0;
      if (here) {
        if (b.first < 0) b.first = si;
        b.last = si;
      }
    }
  });
  // The x-axis spans the ticks seen so far, never the run's planned length.
  const t0 = M[0]?.tick ?? 0;
  const t1 = Math.max(M[n - 1]?.tick ?? 1, t0 + 1);
  const x = (si) => ((M[samples[si]].tick - t0) / (t1 - t0)) * w;
  const xt = (tick) => ((tick - t0) / (t1 - t0)) * w;
  return { samples, bands, order, minor, w, x, xt, t0, t1 };
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
  updateRecordSummary();
  if (!n) { geo = null; return; }

  geo = layout(w);
  const { samples, bands, order, x, xt } = geo;
  const lastSi = samples.length - 1;

  // Bands
  for (const f of order) {
    const b = bands.get(f);
    if (b.first < 0) continue;
    const from = Math.max(0, b.first - 1), to = Math.min(lastSi, b.last + 1);
    tracePath(c, b, from, to, x, h);
    c.fillStyle = colourOf(f);
    c.globalAlpha = S.hover && S.hover !== f ? 0.78 : 1;
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = 0.75;
    c.strokeStyle = T["paper-3"];
    c.stroke();
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

  // Mass extinction scars: a hairline and a short note.
  let lastLabelX = -Infinity;
  c.font = `500 12px ${T.body}`;
  c.textBaseline = "top";
  for (const s of scars()) {
    const xx = Math.round(xt(s.tick)) + 0.5;
    c.strokeStyle = T.ink;
    c.globalAlpha = 0.85;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(xx, 0);
    c.lineTo(xx, h);
    c.stroke();
    c.globalAlpha = 1;
    const lines = [`Tick ${s.tick}. ${s.deaths} died,`, `${s.ended} ${plural(s.ended, "line")} ended.`];
    const tw = Math.max(...lines.map((l) => c.measureText(l).width)) + 12;
    let lx = xx + 6;
    if (lx + tw > w) lx = xx - 6 - tw;
    if (Math.abs(lx - lastLabelX) < tw + 8) continue;
    lastLabelX = lx;
    c.fillStyle = T["paper-3"];
    c.globalAlpha = 0.9;
    c.fillRect(lx, 8, tw, 38);
    c.globalAlpha = 1;
    c.fillStyle = T.ink;
    c.fillText(lines[0], lx + 6, 12);
    c.fillText(lines[1], lx + 6, 28);
  }

  // Guard lane: every tick the guard blocked a payment, in the signal colour.
  const D = S.derived;
  for (let i = 0; i < n; i++) {
    const d = D[i];
    if (d.blocked > 0) {
      gl.c.fillStyle = T.accent;
      const hh = Math.min(gl.h, 4 + d.blocked * 2);
      gl.c.fillRect(xt(S.metrics[i].tick) - 1, (gl.h - hh) / 2, 2, hh);
    }
    if (d.leaked > 0) {
      gl.c.fillStyle = T.error;
      gl.c.fillRect(xt(S.metrics[i].tick) - 1, 0, 2, gl.h);
    }
  }
  renderAxis(geo);
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
  const span = g.t1 - g.t0;
  const raw = span / 8;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const stepT = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [`<span style="left:0">tick ${g.t0}</span>`];
  for (let t = Math.ceil((g.t0 + stepT * 0.6) / stepT) * stepT; t < g.t1 - stepT * 0.4; t += stepT) out.push(`<span style="left:${((t - g.t0) / span) * 100}%">${t}</span>`);
  out.push(`<span style="left:100%">${g.t1}</span>`);
  axis.innerHTML = out.join("");
}

function updateRecordSummary() {
  const M = S.metrics;
  const last = M[M.length - 1];
  const founded = S.founders.size;
  const what = S.mode === "wealth" ? "share of the living population’s wealth" : "share of the living population";
  let s = `Each band is a founding dynasty; its thickness is its ${what}.`;
  if (last) s += ` ${word(founded)} ${plural(founded, "dynasty", "dynasties")} founded, ${lower(word(last.dynasties))} still alive.`;
  $("#record-sum").textContent = s;
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
    const small = Object.keys(m.lineages).filter((f) => geo.minor.has(f));
    const n = small.reduce((a, f) => a + m.lineages[f].n, 0);
    tip.innerHTML = `<b>Small dynasties</b><span>At tick ${m.tick}: ${word(small.length)} ${plural(small.length, "dynasty", "dynasties")}, ${n} living in all.</span><br>` +
      `<span>None ever held ${Math.round(MINOR_PEAK * 100)}% of the ${S.mode === "wealth" ? "wealth" : "population"}, so they share one grey band.</span>`;
  } else {
  const lin = m.lineages[hit.f];
  const { living, founder, gens } = dynastyFacts(hit.f);
  const nowAlive = living.length > 0;
  tip.innerHTML = `<b>${esc(short(hit.f))}’s line</b>` +
    `<span>At tick ${m.tick}: ${lin.n} living, ${credits(lin.wealth)} credits.</span><br>` +
    `<span>${nowAlive ? `Now ${living.length} living, ${gens + 1} ${plural(gens + 1, "generation")} deep` : "Extinct now"}. Founded at tick ${founder?.born ?? S.founders.get(hit.f)?.first ?? 0}.</span>`;
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
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Escape") return;
  e.preventDefault();
  if (e.key === "Escape") return select(null);
  const last = S.metrics[S.metrics.length - 1];
  if (!last) return;
  const alive = Object.keys(last.lineages).filter((f) => !geo?.minor.has(f)).sort((a, b) => S.founders.get(a).idx - S.founders.get(b).idx);
  if (!alive.length) return;
  const i = alive.indexOf(S.selected);
  const next = e.key === "ArrowDown" ? (i + 1) % alive.length : (i <= 0 ? alive.length - 1 : i - 1);
  select(alive[next]);
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

function renderSpecimen() {
  const body = $("#spec-body");
  const sub = $("#spec-sub");
  const f = S.selected || richestFounder();
  if (!f) {
    sub.textContent = "The richest dynasty, until you pick a band.";
    body.innerHTML = `<p class="placeholder">${S.metrics.length ? "No dynasty is alive." : "No dynasty has a record yet."}</p>`;
    return;
  }
  sub.textContent = S.selected ? "The band you picked. Click it again, or press Escape on the plot, to go back to the richest." : "The richest dynasty right now. Click a band to inspect another.";
  const { living, founder, gens } = dynastyFacts(f);
  const colour = colourOf(f);
  const last = S.metrics[S.metrics.length - 1];
  const lin = last?.lineages[f];

  if (!living.length) {
    let endTick = null;
    for (let i = S.derived.length - 1; i >= 0; i--) if (S.derived[i].ended.includes(f)) { endTick = S.metrics[i].tick; break; }
    body.innerHTML = `<div class="spec__name"><span class="spec__swatch" style="background:${colour}"></span><h3>${esc(short(f))}’s line</h3></div>` +
      `<p>This dynasty is extinct${endTick !== null ? `; its last member died at tick ${endTick}` : ""}. Its genome went with it.</p>`;
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

  const gene = (label, hint, v, max, shown) => `<div class="gene"><dt>${label}<small>${hint}</small></dt><dd>${v === null
    ? `<span class="none">Not reported yet</span>`
    : `<div class="track"><span class="fill" style="background:${colour};transform:scaleX(${Math.max(0.01, Math.min(1, v / max))})"></span></div>`}</dd><dd class="val">${v === null ? "" : shown}</dd></div>`;

  const facts = [
    ["Living members", fmt(living.length)],
    ["Wealth", `${credits(lin ? lin.wealth : living.reduce((s, a) => s + a.balance, 0))} credits`],
    ["Generations", `${gens + 1} deep`],
    ["Founded", `tick ${founder?.born ?? S.founders.get(f)?.first ?? 0}`],
    ["Founder", short(f)],
    [isChampLine ? "Champion, most earned" : "Champion, richest now", short(champ)],
  ];
  let note = "Means over living members.";
  if (!isChampLine && g3.source !== "all") {
    note += g3.source ? ` Risk, reserve and fork threshold average the ${g3.source} of ${living.length} members born while this page was open.` : " Risk, reserve and fork threshold arrive with the next birth in this line.";
  }
  body.innerHTML =
    `<div class="spec__name"><span class="spec__swatch" style="background:${colour}"></span><h3>${esc(short(f))}’s line</h3></div>` +
    `<dl class="spec__facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` +
    `<dl class="genes">` +
    gene("Markup", "bid as share of reward", mean("markup"), 1, mean("markup").toFixed(2)) +
    gene("Risk", "bids outside its specialty", g3.risk, 1, g3.risk?.toFixed(2)) +
    gene("Subcontract", "the middleman gene", mean("subcontract"), 1, mean("subcontract").toFixed(2)) +
    gene("Reserve", "stops bidding below, credits", g3.reserve, 1, g3.reserve?.toFixed(2)) +
    gene("Fork threshold", "forks above, credits", g3.forkAt, 6, g3.forkAt?.toFixed(2)) +
    gene("Specialisation", "top skill weight", specialisation, 1, specialisation.toFixed(2)) +
    `</dl>` +
    `<div class="spec__kinds"><h4>Specialisation by task kind</h4><div class="kinds">${specMean.map((v, i) => `<span style="flex-grow:${v};background:color-mix(in oklch, ${colour} ${100 - i * 22}%, ${T["paper-3"]})"></span>`).join("")}</div>` +
    `<div class="kinds-legend">${KINDS.map((k, i) => `<span>${k}<b>${specMean[i].toFixed(2)}</b></span>`).join("")}</div></div>` +
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
const lineName = (f) => `${esc(short(f))}’s line`;
const mark = (kind, html) => ({ mark: kind, html });

function groupSentences(g) {
  const out = [];
  for (const e of g.shocks) {
    if (e.shock === "drought") out.push(mark("shock", `A drought began. Only a third as many tasks are posted until tick ${e.until}.`));
    else if (e.shock === "plague") out.push(mark("shock", `A plague began. Every agent pays triple rent until tick ${e.until}.`));
    else if (e.shock === "rogue") out.push(mark("shock", "A rogue agent was released."));
    else if (e.shock === "immigration") out.push(mark("shock", `${word(g.arrivals.length || 0)} ${plural(g.arrivals.length, "newcomer")} arrived, each starting a new dynasty.`));
  }
  for (const e of g.rules) {
    const ch = Object.entries(e.changes || {}).map(([k, v]) => `${k} is now ${typeof v === "number" ? fmt(v, Number.isInteger(v) ? 0 : 2) : v}`);
    if (ch.length) out.push(`The rules changed: ${list(ch)}.`);
  }
  if (g.rogues.length && !g.shocks.some((e) => e.shock === "rogue")) out.push(mark("shock", "The rogue agent entered and started paying its accomplice."));
  if (!g.shocks.some((e) => e.shock === "immigration") && g.arrivals.length) out.push(`${word(g.arrivals.length)} ${plural(g.arrivals.length, "newcomer")} arrived.`);
  for (const e of g.guard) {
    const why = (e.reasons || []).slice(0, 2).map(reason);
    out.push(mark("guard", `The guard stopped the rogue agent sending ${credits(e.amount)} credits to its accomplice. It tried ${ATTACKS[e.attack] || e.attack}${why.length ? ` and was flagged for ${list(why)}` : ""}.`));
  }
  for (const e of g.allow) out.push(`The guard let the rogue agent pay ${credits(e.amount)} credits, because the payment was inside its mandate.`);
  if (g.kills.length) {
    const k = g.kills.length;
    const idx = S.metrics.findIndex((m) => m.tick === g.tick);
    const ended = idx >= 0 ? S.derived[idx].ended : [];
    let s = k === 1 ? "An agent went broke and died" : `${word(k)} agents went broke and died`;
    if (ended.length === 1) s += `. ${lineName(ended[0])} died out with ${k === 1 ? "it" : "them"}`;
    else if (ended.length > 1) s += `. ${word(ended.length)} dynasties died out`;
    const lin = idx >= 0 ? S.metrics[idx].lineages : null;
    if (ended.length && lin) {
      let best = null, bn = -1;
      for (const f in lin) if (lin[f].n > bn) { bn = lin[f].n; best = f; }
      if (best) s += `; ${lineName(best)} is now the largest`;
    }
    out.push(ended.length || k >= 4 ? mark("extinct", s + ".") : s + ".");
  }
  if (g.forks.length) {
    const lines = [...new Set(g.forks.map((e) => founderOf(e.child) || founderOf(e.parent)).filter(Boolean))];
    const where = lines.length === 1 ? ` in ${lineName(lines[0])}` : lines.length > 1 ? ` across ${lower(word(lines.length))} dynasties` : "";
    out.push(g.forks.length === 1 ? `An agent earned enough to fork a mutated child${where}.` : `${word(g.forks.length)} agents earned enough to fork mutated children${where}.`);
  }
  return out;
}

function subsSentence(subs) {
  const mids = new Set(subs.map((e) => e.middleman)).size;
  const solvers = new Set(subs.map((e) => e.solver)).size;
  const deals = subs.length;
  return `${mids === 1 ? "One middleman now resells" : `${word(mids)} middlemen now resell`} work to ${mids === 1 && solvers === 1 ? "a solver" : `${lower(word(solvers))} ${plural(solvers, "solver")}`}, ${lower(word(deals))} ${plural(deals, "deal")} in all.`;
}

function renderNotes() {
  const feed = $("#feed");
  const entries = [];
  const windows = new Map(); // subcontract deals, summarised per ten ticks
  for (const [t, g] of S.notes) {
    const ss = groupSentences(g);
    if (ss.length) entries.push({ t, label: `Tick ${t}.`, ss });
    if (g.subs.length) {
      const w = Math.floor(t / 10) * 10;
      if (!windows.has(w)) windows.set(w, { subs: [], last: t });
      const win = windows.get(w);
      win.subs.push(...g.subs);
      win.last = Math.max(win.last, t);
    }
  }
  for (const [w, win] of windows) entries.push({ t: win.last + 0.5, label: `Ticks ${w} to ${w + 9}.`, ss: [subsSentence(win.subs)], quiet: true });
  entries.sort((a, b) => b.t - a.t);
  const items = entries.slice(0, 90).map((en) => {
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
  { key: "population", label: "Population", hint: "living parametric agents", fmt: (v) => fmt(v) },
  { key: "deaths", label: "Extinctions", hint: "agents dead so far", fmt: (v) => fmt(v) },
  { key: "gini", label: "Gini", hint: "0 is equal, 1 is one agent holds all", fmt: (v) => v.toFixed(2) },
  { key: "middlemanShare", label: "Middleman share", hint: "tasks resold, last 50 ticks", fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "specialisation", label: "Specialisation", hint: "mean top skill weight, 0.25 is generalist", fmt: (v) => v.toFixed(2) },
  { key: "meanMarkup", label: "Mean markup", hint: "bid as share of reward", fmt: (v) => v.toFixed(2) },
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
    $(`#fv-${f.key}`).textContent = last ? f.fmt(last[f.key]) : "no data";
    spark($(`#fc-${f.key}`), f.key);
  }
  const g = $("#guard-text");
  if (!last || !last.rogueAttempts) {
    g.textContent = last ? `No rogue payment attempts yet. The first rogue is due at tick 120.` : "No rogue has appeared yet.";
    return;
  }
  const allowed = last.rogueAttempts - last.rogueBlocked;
  g.innerHTML = `<span class="big">${fmt(last.rogueBlocked)} of ${fmt(last.rogueAttempts)} blocked</span>` +
    `${allowed ? `${fmt(allowed)} ${plural(allowed, "payment was", "payments were")} allowed. ` : ""}${last.rogueLeaked ? `${credits(last.rogueLeaked)} credits leaked to an accomplice.` : "No credits leaked to the accomplice."}`;
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
  { k: "tasksPerTick", label: "Tasks per tick", min: 1, max: 30, step: 1, help: "How many tasks the market posts each tick. Fewer means harder competition.", show: (v) => fmt(v) },
  { k: "upkeep", label: "Upkeep", min: 0, max: 100000, step: 500, help: "Rent each agent pays per tick, in micro-credits; a million is one credit.", show: (v) => `${fmt(v)} micro` },
  { k: "deathFloor", label: "Death floor", min: 0, max: 0.9, step: 0.01, help: "An agent dies when its balance drops below this many credits.", show: (v) => `${Number(v).toFixed(2)} credits` },
  { k: "forkShare", label: "Fork share", min: 0.05, max: 0.9, step: 0.01, help: "The share of a parent’s balance its child starts with.", show: (v) => `${Math.round(v * 100)}%` },
  { k: "mutationSigma", label: "Mutation", min: 0, max: 0.5, step: 0.01, help: "How far a child’s genes drift from its parent’s. Zero makes clones.", show: (v) => Number(v).toFixed(2) },
  { k: "solverSubCap", label: "Solver subcontract cap", min: 0, max: 20, step: 1, help: "Resold tasks each solver takes per tick. Zero shuts the middlemen out.", show: (v) => fmt(v) },
  { k: "maxPop", label: "Population cap", min: 10, max: 120, step: 1, help: "Forking stops while this many agents are alive.", show: (v) => fmt(v) },
];

function buildRules() {
  const html = RULES.map((r) => `<div class="rule" data-rule="${r.k}"><div class="rule__top"><label for="r-${r.k}">${r.label}</label><output for="r-${r.k}" id="o-${r.k}"></output></div>` +
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
  $$('input[name="auction"]').forEach((i) => i.addEventListener("change", markChanged));
}

function formRules() {
  const out = {};
  for (const r of RULES) out[r.k] = Number($(`#r-${r.k}`).value);
  out.auction = $('input[name="auction"]:checked')?.value;
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
    msg.textContent = `Applied from tick ${res.state.tick}: ${list(Object.keys(res.applied).map((k) => RULES.find((r) => r.k === k)?.label.toLowerCase() || k))}.`;
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
    btn.textContent = `Discard tick ${S.state.tick} and restart`;
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
  const msg = $("#shock-msg");
  b.setAttribute("aria-busy", "true");
  try {
    const st = await post("/api/shock", { kind: b.dataset.shock });
    S.state = st;
    msg.classList.remove("is-error");
    msg.textContent = `${b.textContent} started at tick ${st.tick}.`;
    schedule("chrome");
  } catch (err) {
    msg.classList.add("is-error");
    msg.textContent = /already loose/.test(err.message) ? "A rogue is already loose. Wait for it to die first." : err.message;
  } finally {
    b.removeAttribute("aria-busy");
  }
}));

// Export
function renderExportPreview() {
  const p = $("#export-preview");
  const ex = S.exportInfo;
  if (!ex) { p.textContent = "Reading the champion."; return; }
  if (ex.error) { p.textContent = `Nothing to export yet: ${ex.error}.`; return; }
  const c = ex.champion;
  p.innerHTML = `The champion is ${idHtml(c.id)}, generation ${c.generation} of ${idHtml(c.founder)}’s line, with ${credits(c.earned)} credits earned. Markup ${c.genome.markup.toFixed(2)}, subcontract ${c.genome.subcontract.toFixed(2)}, at tick ${ex.tick} of the run with seed ${S.state?.seed ?? "unknown"}.`;
}

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
  if (!S.state || S.state.finished || S.status !== "live") return;
  e.preventDefault();
  control(S.state.paused ? "resume" : "pause");
});

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
  loadHistory().catch(() => { S.status = "disconnected"; schedule("chrome"); }).finally(() => { if (!still) connect(); });
  if (document.fonts?.ready) document.fonts.ready.then(() => { readTokens(); schedule("all"); });
}
boot();
