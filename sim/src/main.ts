// `make demo`: run the economy live, log every event to SQLite, stream to the dashboard over SSE,
// and accept steering (pause, speed, rules, shocks, reset, export) over a small JSON API.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Economy, TUNABLE, type Shock, type SimEvent } from "./economy.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_TICKS = Number(process.env.TICKS ?? 2000);
const DASH_DIR = path.resolve(here, "../../dashboard");
const DB_PATH = process.env.DARWIN_DB ?? path.resolve(here, "../darwin.sqlite");
const SPEEDS = [1000, 300, 120, 40]; // ms per tick: slow, normal, fast, fastest

const notable = new Set(["born", "fork", "kill", "guard_block", "guard_allow_rogue", "subcontract", "shock", "rules"]);
const clients = new Set<http.ServerResponse>();

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
  seed = Number(process.env.SEED ?? 42);
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
    this.eco = new Economy({ seed }, (e) => this.onEvent(e));
    if (Object.keys(rules).length) this.eco.setRules(rules);
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
    const cols = ["tick", "population", "deaths", "maxGeneration", "dynasties", "gini", "middlemanShare", "specialisation", "meanMarkup", "meanSubcontract", "pool", "rogueAttempts", "rogueBlocked", "rogueLeaked"];
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
    if (req.method === "GET" && p === "/snapshot") return send(res, 200, run.eco.snapshot());
    if (req.method === "GET" && p === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
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
    if (req.method === "POST" && p === "/api/control") {
      const b = await body(req);
      if (b.action === "pause") run.paused = true;
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
      run.eco.shock(kind);
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
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DARWIN: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}   seed ${run.seed}, ${MAX_TICKS} ticks, log ${DB_PATH}`);
});

async function loop() {
  for (;;) {
    const t0 = Date.now();
    if (!run.paused && run.eco.tick < MAX_TICKS) {
      try {
        await run.step();
      } catch (e) {
        console.error("tick failed:", e);
        run.paused = true;
        broadcast("error", { message: (e as Error).message });
        broadcast("state", run.state());
      }
      if (run.eco.tick === MAX_TICKS) broadcast("state", run.state());
      if (run.eco.tick % 100 === 0) {
        const m = run.eco.lastMetrics;
        console.log(`t=${m.tick} pop=${m.population} deaths=${m.deaths} gen=${m.maxGeneration} middlemen=${(m.middlemanShare * 100).toFixed(0)}% rogue blocked ${m.rogueBlocked}/${m.rogueAttempts}`);
      }
    }
    await new Promise((r) => setTimeout(r, Math.max(5, SPEEDS[run.speed] - (Date.now() - t0))));
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  run.db.close();
  process.exit(0);
});
loop();
