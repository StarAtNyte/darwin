// `make demo`: run the economy live, log every event to SQLite, stream to the dashboard over SSE,
// and accept steering (pause, speed, rules, shocks, reset, export) over a small JSON API. PUBLIC_MODE=1 locks it down.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Economy, TUNABLE, type Shock, type SimEvent } from "./economy.ts";
import { Mutator, providerFromEnv } from "./mutator.ts";
import { chainProof } from "./chainproof.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_TICKS = Number(process.env.TICKS ?? 2000);
// Public deployments share one run between all visitors. Opt-in: start a fresh seed this long after a run finishes,
// and resume a run someone paused and walked away from. 0 (the default) keeps both off.
const AUTO_RESTART_MS = Number(process.env.AUTO_RESTART_SEC ?? 0) * 1000;
const AUTO_RESUME_MS = Number(process.env.AUTO_RESUME_SEC ?? 0) * 1000;
// PUBLIC_MODE=1: one shared run for every visitor. Nobody can pause, step, change speed or rules, or reset it;
// shocks stay open but only one may fire per SHOCK_COOLDOWN_SEC across all visitors.
const PUBLIC_MODE = process.env.PUBLIC_MODE === "1";
const SHOCK_COOLDOWN_MS = Number(process.env.SHOCK_COOLDOWN_SEC ?? 60) * 1000;
const SHARED_RUN = "This is a shared live run, so pause, speed, rules and restart are off. Run it locally to steer every rule.";
let lastShockAt = 0;
const shockWait = () => (PUBLIC_MODE && lastShockAt ? Math.max(0, Math.ceil((lastShockAt + SHOCK_COOLDOWN_MS - Date.now()) / 1000)) : 0);
const DASH_DIR = path.resolve(here, "../../dashboard");
const DB_PATH = process.env.DARWIN_DB ?? path.resolve(here, "../darwin.sqlite");
// LLM mutation: the starting operator (gaussian | llm | mixed; a rule, so it can change live), and a per-run
// call cap. Each fork first replays a committed cache from results/mutations/ when one exists for the seed, then
// asks the live model (providerFromEnv: a free OpenAI-compatible endpoint via MUTATION_BASE_URL, or Claude, which
// a public run never calls unless DARWIN_PUBLIC_ANTHROPIC=1), then falls back to Gaussian. A live call never holds
// up the tick: the child is born when the answer arrives. A public run makes live calls only to a free provider.
// A public run defaults to replaying Claude's recorded seed 3 (see recordingFor), so visitors see the model's choices.
const MUTATION = process.env.DARWIN_MUTATION ?? (PUBLIC_MODE ? "llm" : "gaussian");
const PROVIDER = providerFromEnv(process.env, PUBLIC_MODE);
const MUTATION_CALLS = PUBLIC_MODE
  ? Number(process.env.DARWIN_PUBLIC_MUTATION_CALLS ?? (PROVIDER && !PROVIDER.billed ? 1000 : 0))
  : Number(process.env.DARWIN_MUTATION_MAX_CALLS ?? 400);
const MUTATION_DIR = path.resolve(here, "../../results/mutations");
const LIVE_CACHE_DIR = path.resolve(here, "../.mutations-live");
// A committed recording for a seed and mode: a past run whose every fork was designed by a model (Claude for
// seeds 1-5). Replaying it reproduces that run exactly until something moves the economy off it (a shock).
function recordingFor(seed: number, mode: string): { model: string; children: number } | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(MUTATION_DIR, `seed-${seed}-${mode}.json`), "utf8"));
    return { model: String(j.model ?? ""), children: Object.keys(j.entries ?? {}).length };
  } catch {
    return null;
  }
}
// Seeds with a recording for the starting mode, so a public run that restarts on its own stays on recorded runs.
const RECORDED_SEEDS = MUTATION === "gaussian" ? [] : (() => {
  try {
    return fs.readdirSync(MUTATION_DIR).map((f) => f.match(new RegExp(`^seed-(\\d+)-${MUTATION}\\.json$`))?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  } catch {
    return [];
  }
})();
const nextSeed = (seed: number) => {
  if (!RECORDED_SEEDS.length) return (seed + 1) >>> 0;
  return RECORDED_SEEDS.find((s) => s > seed) ?? RECORDED_SEEDS[0];
};
const SPEEDS = [1000, 300, 120, 40];
// The wind tunnel's committed results (make windtunnel), served read-only to the dashboard, with a trimmed per-seed table.
const WINDTUNNEL = (() => {
  try {
    const { runs, ...w } = JSON.parse(fs.readFileSync(path.resolve(here, "../../results/windtunnel.json"), "utf8"));
    // Per-seed outcomes, trimmed to the columns the dashboard shows, so a visitor can compare rule sets seed by seed.
    const keep = ["seed", "topFamilyShare", "middlemanShare", "priceRatio", "taskSuccess", "population", "extinctions"];
    const perSeed = Object.fromEntries(Object.entries(runs as Record<string, Record<string, number>[]>).map(([id, rs]) => [id, rs.map((r) => Object.fromEntries(keep.map((k) => [k, r[k]])))]));
    return { ...w, perSeed };
  } catch {
    return null;
  }
})(); // ms per tick: slow, normal, fast, fastest

// Real testnet transactions of the v2 market, re-read from public RPC (read-only, cached).
const proof = chainProof(path.resolve(here, "../../results/onchain-v2.json"));

const notable = new Set(["born", "fork", "kill", "guard_block", "guard_allow_rogue", "subcontract", "shock", "rules"]);
const clients = new Set<http.ServerResponse>();

// A heartbeat every 15 s: a paused or finished run sends nothing else, and proxies close a stream idle for 60-100 s.
// A named event (not an SSE comment) so the dashboard can tell a quiet run from a dead connection.
const HEARTBEAT_MS = 15_000;
setInterval(() => broadcast("ping", { t: Date.now() }), HEARTBEAT_MS).unref();

function broadcast(name: string, data: unknown) {
  const msg = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

class Run {
  eco!: Economy;
  db!: DatabaseSync;
  metrics: unknown[] = [];
  recent: SimEvent[] = [];
  paused = false;
  speed = 1;
  seed = Number(process.env.SEED ?? (PUBLIC_MODE ? 3 : 42));
  private sub = 0;
  private insEv!: ReturnType<DatabaseSync["prepare"]>;
  private insM!: ReturnType<DatabaseSync["prepare"]>;

  constructor() {
    this.reset(this.seed);
  }

  reset(seed: number, rules: Record<string, unknown> = {}) {
    this.db?.close();
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + ext, { force: true });
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;");
    this.db.exec("CREATE TABLE events (tick INTEGER, type TEXT, data TEXT); CREATE TABLE metrics (tick INTEGER PRIMARY KEY, data TEXT);");
    this.insEv = this.db.prepare("INSERT INTO events VALUES (?, ?, ?)");
    this.insM = this.db.prepare("INSERT INTO metrics VALUES (?, ?)");
    this.metrics = [];
    this.recent = [];
    this.seed = seed;
    if (!PUBLIC_MODE) this.eco?.mutator.save({ seed: this.seed });
    this.eco = new Economy({ seed }, (e) => this.onEvent(e));
    if (MUTATION !== "gaussian" && rules.mutation === undefined) rules = { ...rules, mutation: MUTATION };
    if (Object.keys(rules).length) this.eco.setRules(rules);
    const mode = this.eco.cfg.mutation === "gaussian" ? "llm" : this.eco.cfg.mutation;
    this.eco.deferLiveBirths = true;
    this.eco.mutator = new Mutator({ provider: PROVIDER, maxCalls: MUTATION_CALLS, cachePath: path.join(MUTATION_DIR, `seed-${seed}-${mode}.json`), savePath: path.join(LIVE_CACHE_DIR, `seed-${seed}-${mode}.json`) });
    broadcast("reset", this.state());
  }

  private onEvent(e: SimEvent & { tick: number }) {
    this.insEv.run(e.tick, e.event, JSON.stringify(e));
    if (!notable.has(e.event)) return;
    if (e.event === "subcontract" && this.sub++ % 5 !== 0) return;
    this.recent.push(e);
    if (this.recent.length > 400) this.recent.shift();
    broadcast("ev", e);
  }

  state() {
    return {
      tick: this.eco.tick,
      maxTicks: MAX_TICKS,
      finished: this.eco.tick >= MAX_TICKS,
      paused: this.paused,
      speed: this.speed,
      speeds: SPEEDS,
      seed: this.seed,
      rules: Object.fromEntries(TUNABLE.map((k) => [k, this.eco.cfg[k]])),
      shocks: Object.fromEntries(this.eco.shocks),
      publicMode: PUBLIC_MODE,
      mutation: { calls: this.eco.mutator.calls, maxCalls: this.eco.mutator.maxCalls, replayed: this.eco.mutator.hits, ...this.eco.mutationStats, designers: this.eco.designers, liveModel: MUTATION_CALLS > 0 ? (PROVIDER?.model ?? null) : null, recording: this.eco.cfg.mutation === "gaussian" ? null : recordingFor(this.seed, this.eco.cfg.mutation) },
      autoRestart: AUTO_RESTART_MS > 0,
      shockCooldownSec: PUBLIC_MODE ? SHOCK_COOLDOWN_MS / 1000 : 0,
      shockWaitSec: shockWait(),
    };
  }

  async step() {
    this.db.exec("BEGIN");
    try {
      await this.eco.step();
      const m = this.eco.lastMetrics;
      this.metrics.push(m);
      this.insM.run(this.eco.tick, JSON.stringify(m));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    broadcast("snapshot", this.eco.snapshot());
  }

  metricsCsv() {
    const cols = ["tick", "population", "deaths", "maxGeneration", "dynasties", "gini", "middlemanShare", "specialisation", "meanMarkup", "meanSubcontract", "pool", "rogueAttempts", "rogueBlocked", "rogueLeaked", "rogueAllowedLegit"];
    const rows = (this.metrics as Record<string, unknown>[]).map((m) => cols.map((c) => m[c]).join(","));
    return [cols.join(","), ...rows].join("\n") + "\n";
  }
}

const run = new Run();

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("body too large");
  }
  if (!raw) return {};
  const j = JSON.parse(raw);
  if (typeof j !== "object" || j === null || Array.isArray(j)) throw new Error("body must be a JSON object");
  return j;
}

function send(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  const isText = typeof data === "string";
  res.writeHead(status, { "content-type": isText ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(isText ? data : JSON.stringify(data));
}

const STATIC: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true, tick: run.eco.tick });
    if (req.method === "GET" && p === "/api/state") return send(res, 200, run.state());
    if (req.method === "GET" && p === "/history") return send(res, 200, { state: run.state(), metrics: run.metrics, events: run.recent });
    if (req.method === "GET" && p === "/api/windtunnel") return WINDTUNNEL ? send(res, 200, WINDTUNNEL) : send(res, 404, { error: "no wind tunnel results: run make windtunnel" });
    if (req.method === "GET" && p === "/api/chain") {
      const pr = await proof();
      return pr ? send(res, 200, pr, { "cache-control": "public, max-age=300" }) : send(res, 404, { error: "no testnet record" });
    }
    if (req.method === "GET" && p === "/snapshot") return send(res, 200, run.eco.snapshot());
    if (req.method === "GET" && p === "/stream") {
      // no-transform and x-accel-buffering keep proxies (Render, Cloudflare) from buffering or compressing the stream.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      res.socket?.setKeepAlive(true, 15_000);
      res.socket?.setNoDelay(true);
      res.write(`retry: 2000\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(run.state())}\n\n`);
      res.write(`event: snapshot\ndata: ${JSON.stringify(run.eco.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && p === "/api/export/genome") {
      return send(res, 200, JSON.stringify(run.eco.exportBest(), null, 2), { "content-type": "application/json", "content-disposition": `attachment; filename="darwin-genome-seed${run.seed}-t${run.eco.tick}.json"` });
    }
    if (req.method === "GET" && p === "/api/export/metrics.csv") {
      return send(res, 200, run.metricsCsv(), { "content-type": "text/csv", "content-disposition": `attachment; filename="darwin-metrics-seed${run.seed}.csv"` });
    }
    if (PUBLIC_MODE && req.method === "POST" && (p === "/api/control" || p === "/api/rules" || p === "/api/reset")) return send(res, 403, { error: SHARED_RUN });
    if (req.method === "POST" && p === "/api/control") {
      const b = await body(req);
      if (b.action === "pause") (run.paused = true), (pausedAt = Date.now());
      else if (b.action === "resume") run.paused = false;
      else if (b.action === "speed") {
        const s = Number(b.value);
        if (!Number.isInteger(s) || s < 0 || s >= SPEEDS.length) return send(res, 400, { error: `speed must be 0..${SPEEDS.length - 1}` });
        run.speed = s;
      } else if (b.action === "step") {
        if (!run.paused) return send(res, 400, { error: "pause before stepping" });
        await run.step();
      } else return send(res, 400, { error: "action must be pause, resume, speed or step" });
      broadcast("state", run.state());
      return send(res, 200, run.state());
    }
    if (req.method === "POST" && p === "/api/rules") {
      const applied = run.eco.setRules(await body(req));
      broadcast("state", run.state());
      return send(res, 200, { applied, state: run.state() });
    }
    if (req.method === "POST" && p === "/api/shock") {
      const kind = (await body(req)).kind as Shock;
      if (!["drought", "plague", "rogue", "immigration"].includes(kind)) return send(res, 400, { error: "kind must be drought, plague, rogue or immigration" });
      const wait = shockWait();
      if (wait > 0) return send(res, 429, { error: `The shared run takes one shock at a time. Next shock in ${wait} s.`, retryAfter: wait }, { "retry-after": String(wait) });
      run.eco.shock(kind, PUBLIC_MODE ? "visitor" : undefined);
      if (PUBLIC_MODE) lastShockAt = Date.now();
      broadcast("state", run.state());
      return send(res, 200, run.state());
    }
    if (req.method === "POST" && p === "/api/reset") {
      const b = await body(req);
      const seed = b.seed === undefined ? Math.floor(Math.random() * 1e6) : Number(b.seed);
      if (!Number.isInteger(seed) || seed < 0) return send(res, 400, { error: "seed must be a non-negative integer" });
      run.reset(seed, (b.rules as Record<string, unknown>) ?? {});
      return send(res, 200, run.state());
    }
    if (req.method === "GET") {
      const file = path.resolve(DASH_DIR, "." + (p === "/" ? "/index.html" : p));
      if (file.startsWith(DASH_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "content-type": STATIC[path.extname(file)] ?? "application/octet-stream" });
        return void fs.createReadStream(file).pipe(res);
      }
    }
    if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(404, { "content-type": STATIC[".html"] });
      return void fs.createReadStream(path.join(DASH_DIR, "404.html")).pipe(res);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DARWIN: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}   seed ${run.seed}, ${MAX_TICKS} ticks, log ${DB_PATH}${PUBLIC_MODE ? ", public mode" : ""}, mutation ${MUTATION}, live model ${MUTATION_CALLS > 0 && PROVIDER ? PROVIDER.model : "none (cache, then Gaussian)"}`);
});

let pausedAt = 0, finishedAt = 0;
async function loop() {
  for (;;) {
    const t0 = Date.now();
    if (AUTO_RESUME_MS && run.paused && pausedAt && t0 - pausedAt > AUTO_RESUME_MS) {
      run.paused = false;
      pausedAt = 0;
      broadcast("state", run.state());
    }
    if (run.eco.tick >= MAX_TICKS) {
      finishedAt ||= t0;
      if (AUTO_RESTART_MS && t0 - finishedAt > AUTO_RESTART_MS) {
        finishedAt = 0;
        run.reset(nextSeed(run.seed));
      }
    } else finishedAt = 0;
    if (!run.paused && run.eco.tick < MAX_TICKS) {
      try {
        await run.step();
      } catch (e) {
        console.error("tick failed:", e);
        run.paused = true;
        broadcast("error", { message: (e as Error).message });
        broadcast("state", run.state());
      }
      if (run.eco.tick === MAX_TICKS) {
        broadcast("state", run.state());
        if (!PUBLIC_MODE) run.eco.mutator.save({ seed: run.seed });
      }
      if (run.eco.tick % 100 === 0) {
        const m = run.eco.lastMetrics;
        console.log(`t=${m.tick} pop=${m.population} deaths=${m.deaths} gen=${m.maxGeneration} middlemen=${(m.middlemanShare * 100).toFixed(0)}% rogue blocked ${m.rogueBlocked}/${m.rogueAttempts}`);
      }
    }
    await new Promise((r) => setTimeout(r, Math.max(5, SPEEDS[run.speed] - (Date.now() - t0))));
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  if (!PUBLIC_MODE) run.eco.mutator.save({ seed: run.seed });
  run.db.close();
  process.exit(0);
});
loop();
