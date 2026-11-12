// PUBLIC_MODE: the shared run refuses steering (403) and rate-limits shocks globally (429).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-public-"));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let srv: ChildProcess;

before(async () => {
  srv = spawn(process.execPath, ["--import", "tsx", path.join(here, "../src/main.ts")], {
    cwd: path.join(here, ".."),
    env: { ...process.env, MUTATION_BASE_URL: "", ANTHROPIC_API_KEY: "", PUBLIC_MODE: "1", PORT: String(PORT), HOST: "127.0.0.1", DARWIN_DB: path.join(dir, "t.sqlite"), TICKS: "50" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => {
  srv.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("public mode: state says so", async () => {
  const st = await (await fetch(`${base}/api/state`)).json();
  assert.equal(st.publicMode, true);
  assert.equal(st.shockWaitSec, 0);
});

test("public mode: pause, step, speed, rules and reset are refused with 403", async () => {
  for (const [p, b] of [["/api/control", { action: "pause" }], ["/api/control", { action: "step" }], ["/api/control", { action: "speed", value: 3 }], ["/api/rules", { upkeep: 1 }], ["/api/reset", { seed: 1 }]] as const) {
    const r = await post(p, b);
    assert.equal(r.status, 403, `${p} ${JSON.stringify(b)}`);
    assert.match((await r.json()).error, /shared live run/);
  }
  assert.equal((await (await fetch(`${base}/api/state`)).json()).paused, false);
});

test("public mode: one shock per minute across visitors, then 429 with the wait", async () => {
  const ok = await post("/api/shock", { kind: "drought" });
  assert.equal(ok.status, 200);
  const st = await ok.json();
  assert.ok(st.shockWaitSec > 55 && st.shockWaitSec <= 60);
  const again = await post("/api/shock", { kind: "plague" });
  assert.equal(again.status, 429);
  const j = await again.json();
  assert.ok(j.retryAfter > 0 && j.retryAfter <= 60);
  assert.equal(again.headers.get("retry-after"), String(j.retryAfter));
  assert.match(j.error, /Next shock in \d+ s/);
  const h = await (await fetch(`${base}/history`)).json();
  const ev = h.events.find((e: { event: string }) => e.event === "shock");
  assert.equal(ev?.by, "visitor");
});
