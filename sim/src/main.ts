// `make demo`: run the economy live, log every event to SQLite, stream to the dashboard over SSE.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Economy, type SimEvent } from "./economy.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const TICK_MS = Number(process.env.TICK_INTERVAL_MS ?? 300);
const MAX_TICKS = Number(process.env.TICKS ?? 2000); // ~10 min at 300 ms
const DASH = path.resolve(here, "../../dashboard/index.html");
const DB_PATH = process.env.DARWIN_DB ?? path.resolve(here, "../darwin.sqlite");

fs.rmSync(DB_PATH, { force: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;");
db.exec(`CREATE TABLE events (tick INTEGER, type TEXT, data TEXT); CREATE TABLE metrics (tick INTEGER PRIMARY KEY, data TEXT);`);
const insEv = db.prepare("INSERT INTO events VALUES (?, ?, ?)");
const insM = db.prepare("INSERT INTO metrics VALUES (?, ?)");

const clients = new Set<http.ServerResponse>();
const notable = new Set(["born", "fork", "kill", "guard_block", "guard_allow_rogue", "subcontract"]);
const recentNotable: SimEvent[] = [];
let subSample = 0;

function broadcast(name: string, data: unknown) {
  const msg = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

const eco = new Economy({ seed: Number(process.env.SEED ?? 42) }, (e) => {
  insEv.run(e.tick, e.event, JSON.stringify(e));
  if (!notable.has(e.event)) return;
  if (e.event === "subcontract" && subSample++ % 5 !== 0) return; // sample the chatty ones
  recentNotable.push(e);
  if (recentNotable.length > 300) recentNotable.shift();
  broadcast("ev", e);
});

const metricsHistory: unknown[] = [];

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/" || url.startsWith("/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.existsSync(DASH) ? fs.readFileSync(DASH) : "<h1>dashboard/index.html missing</h1>");
  } else if (url === "/history") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ metrics: metricsHistory, events: recentNotable }));
  } else if (url === "/snapshot") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(eco.snapshot()));
  } else if (url === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: snapshot\ndata: ${JSON.stringify(eco.snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  } else {
    res.writeHead(404).end();
  }
});

server.listen(PORT, () => {
  console.log(`DARWIN dashboard: http://localhost:${PORT}   (${MAX_TICKS} ticks every ${TICK_MS} ms, log ${DB_PATH})`);
});

async function loop() {
  while (eco.tick < MAX_TICKS) {
    const t0 = Date.now();
    db.exec("BEGIN");
    await eco.step();
    const m = eco.lastMetrics;
    metricsHistory.push(m);
    insM.run(eco.tick, JSON.stringify(m));
    db.exec("COMMIT");
    broadcast("snapshot", eco.snapshot());
    if (eco.tick % 100 === 0) {
      console.log(`t=${m.tick} pop=${m.population} deaths=${m.deaths} gen=${m.maxGeneration} middlemen=${(m.middlemanShare * 100).toFixed(0)}% rogue blocked ${m.rogueBlocked}/${m.rogueAttempts} leaked ${m.rogueLeaked}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, TICK_MS - (Date.now() - t0))));
  }
  console.log("economy finished; dashboard stays up (Ctrl-C to exit)");
}
loop();
