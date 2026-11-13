// PUBLIC_MODE: the shared run refuses steering (403) and rate-limits shocks globally (429).
import { test as baseTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-public-"));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let srv: ChildProcess;

// Some sandboxes (e.g. Codex workspace-write) forbid binding any TCP port (listen EPERM). Then this suite cannot
// run at all, so skip it loudly rather than fail on something the code under test did not do.
const canListen = await new Promise<boolean>((res) => {
  const s = net.createServer();
  s.once("error", () => res(false));
  s.listen(0, "127.0.0.1", () => s.close(() => res(true)));
});
if (!canListen) console.warn("SKIPPED public.test.ts: sandbox forbids listening on TCP ports (EPERM)");
const test = canListen ? baseTest : ((n: string) => baseTest.skip(n)) as typeof baseTest;

before(async () => {
  if (!canListen) return;
  srv = spawn(process.execPath, ["--import", "tsx", path.join(here, "../src/main.ts")], {
    cwd: path.join(here, ".."),
    env: { ...process.env, MUTATION_BASE_URL: "", ANTHROPIC_API_KEY: "", PUBLIC_MODE: "1", PORT: String(PORT), HOST: "127.0.0.1", DARWIN_DB: path.join(dir, "t.sqlite"), TICKS: "400", TEST_RULES_SEEDS: "2", TEST_RULES_ROUNDS: "60", TEST_RULES_WARM_SEC: "3600" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => {
  if (!canListen) return;
  srv.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("public mode: state says so", async () => {
  const st = await (await fetch(`${base}/api/state`)).json();
  assert.equal(st.publicMode, true);
  assert.equal(st.shockWaitSec, 0);
});

test("public mode: the run opens at round 135, with rounds 1 to 135 kept in the history", async () => {
  const h = await (await fetch(`${base}/history`)).json();
  assert.equal(h.state.startRound, 135);
  assert.ok(h.state.tick >= 135);
  assert.equal(h.metrics[0].tick, 1);
  assert.ok(h.metrics.length >= 135);
  assert.ok(h.metrics[134].rogueAttempts > 0, "the first rogue (round 120) has already struck");
  assert.ok(h.events.some((e: { event: string }) => e.event === "guard_block"));
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

test("public mode: the wind tunnel results are readable, with a trimmed per-seed table", async () => {
  const r = await fetch(`${base}/api/windtunnel`);
  assert.equal(r.status, 200);
  const w = await r.json();
  assert.equal(w.ruleSets[0].id, "baseline");
  assert.ok(w.vsBaseline["price-auction"].taskSuccess.p < 0.05);
  assert.equal(w.runs, undefined);
  assert.equal(w.perSeed.baseline.length, w.seeds.length);
  assert.deepEqual(Object.keys(w.perSeed.baseline[0]).sort(), ["extinctions", "middlemanShare", "population", "priceRatio", "seed", "taskSuccess", "topFamilyShare"]);
});

test("public mode: test your rules: a preset comes back precomputed; bad rules are refused with 400", async () => {
  const st = await (await fetch(`${base}/api/test-rules`)).json();
  assert.deepEqual(st.live, { seeds: 2, rounds: 60 });
  assert.equal(st.grid.rounds, 2000);
  assert.ok(st.presets.length >= 2);
  assert.equal(st.perIpSec, 20);
  const r = await post("/api/test-rules", { rules: st.presets[0].rules });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.source, "precomputed");
  assert.match(j.headline, /^Your rules: successful jobs \d+% → \d+%/);
  assert.deepEqual(Object.keys(j.metrics[0]).sort(), ["baseline", "ci", "diff", "key", "label", "p", "perSeed", "unit", "verdict", "yours"]);
  for (const bad of [{ rules: { deathFloor: 0.5 } }, { rules: { auction: "free" } }, { rules: [] }]) {
    const b = await post("/api/test-rules", bad);
    assert.equal(b.status, 400, JSON.stringify(bad));
    assert.ok((await b.json()).error);
  }
});

test("public mode: test your rules: one live test per visitor every 20 s, then 429 with the wait", async () => {
  const hdr = { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" };
  const one = await fetch(`${base}/api/test-rules`, { method: "POST", headers: hdr, body: JSON.stringify({ rules: { upkeep: 7777 } }) });
  assert.equal(one.status, 200);
  const j = await one.json();
  assert.equal(j.source, "live");
  assert.equal(j.rounds, 60);
  const two = await fetch(`${base}/api/test-rules`, { method: "POST", headers: hdr, body: JSON.stringify({ rules: { upkeep: 7000 } }) });
  assert.equal(two.status, 429);
  const k = await two.json();
  assert.ok(k.retryAfter > 0 && k.retryAfter <= 20);
  assert.equal(two.headers.get("retry-after"), String(k.retryAfter));
  // The same rules again are a cache hit, which costs nothing and is never limited.
  const again = await fetch(`${base}/api/test-rules`, { method: "POST", headers: hdr, body: JSON.stringify({ rules: { upkeep: 7777 } }) });
  assert.equal((await again.json()).source, "cache");
});
