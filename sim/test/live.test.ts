// The live settler's rate limit and the automatic new epoch when one family takes over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Settler, memoFor, type SendFn } from "../src/settler.ts";
import { EpochWatch } from "../src/epoch.ts";

const ev = (tick: number) => ({ tick, seed: 3, agent: "rogue-1.darwin.testnet", to: "sink", amount: 100_000 });

test("settler: off without a sender", () => {
  const s = new Settler(null);
  assert.equal(s.enabled, false);
  assert.equal(s.offer(ev(1)), null);
});

test("settler: at most one tx per interval, one in flight, and a daily cap", async () => {
  let t = Date.UTC(2026, 10, 13, 12);
  const sent: string[] = [];
  let release: () => void = () => {};
  const send: SendFn = (e, memo) => {
    sent.push(memo);
    return new Promise((r) => (release = () => r({ hash: `h${e.tick}`, reason: "BAD_SIGNATURE" })));
  };
  const seen: number[] = [];
  const s = new Settler(send, { minIntervalMs: 45_000, maxPerDay: 2, now: () => t, onSettled: (x) => seen.push(x.tick) });
  const p = s.offer(ev(10));
  assert.ok(p);
  t += 60_000;
  assert.equal(s.offer(ev(11)), null, "one in flight");
  release();
  assert.equal((await p)!.reason, "BAD_SIGNATURE");
  assert.deepEqual(seen, [10]);
  t += 10_000;
  assert.ok(s.offer(ev(12)), "70 s after the first send started, past the 45 s interval");
});

test("settler: interval measured from the last send", async () => {
  let t = Date.UTC(2026, 10, 13, 12);
  const send: SendFn = async (e) => ({ hash: `h${e.tick}`, reason: "BAD_SIGNATURE" });
  const s = new Settler(send, { minIntervalMs: 45_000, maxPerDay: 3, now: () => t });
  await s.offer(ev(1));
  t += 44_999;
  assert.equal(s.offer(ev(2)), null);
  t += 1;
  assert.ok(await s.offer(ev(3)));
  t += 45_000;
  assert.ok(await s.offer(ev(4)));
  t += 45_000;
  assert.equal(s.offer(ev(5)), null, "daily cap of 3 reached");
  t += 24 * 3600_000;
  assert.ok(await s.offer(ev(6)), "a new UTC day resets the cap");
  assert.deepEqual(s.recent.map((r) => r.tick), [6, 4, 3, 1]);
});

test("settler: a failed send is recorded without the event and does not throw", async () => {
  const s = new Settler(async () => { throw new Error("rpc down"); }, { minIntervalMs: 1, maxPerDay: 9, now: () => 0 });
  assert.equal(await s.offer(ev(1)), null);
  assert.match(s.lastError!, /rpc down/);
  assert.equal(s.recent.length, 0);
});

test("settler: the memo fits the contract (64 chars of a-z 0-9 space _ -)", () => {
  const m = memoFor({ ...ev(1234), agent: "Rogue-7.darwin.testnet" });
  assert.match(m, /^[a-z0-9 _-]{1,64}$/);
  assert.match(m, /round 1234/);
});

test("epoch: fires after one family holds the share for `hold` rounds, then rearms", () => {
  const w = new EpochWatch(0.9, 100);
  const big = { a22: { n: 19 }, a3: { n: 1 } }; // 95%
  const split = { a22: { n: 17 }, a3: { n: 3 } }; // 85%
  for (let t = 1; t <= 50; t++) assert.equal(w.observe(t, big), null);
  assert.equal(w.observe(51, split), null, "dropping below the line resets the streak");
  let took = null;
  for (let t = 52; t <= 151 && !took; t++) took = w.observe(t, big);
  assert.deepEqual(took && { founder: took.founder, since: took.since, tick: took.tick }, { founder: "a22", since: 52, tick: 151 });
  assert.equal(w.observe(152, big), null, "rearmed after firing");
});

test("epoch: a different family taking the lead restarts the count; hold 0 is off", () => {
  const w = new EpochWatch(0.9, 3);
  assert.equal(w.observe(1, { a: { n: 10 } }), null);
  assert.equal(w.observe(2, { b: { n: 10 } }), null);
  assert.equal(w.observe(3, { b: { n: 10 } }), null);
  assert.equal(w.observe(4, { b: { n: 10 } })?.since, 2);
  const off = new EpochWatch(0.9, 0);
  for (let t = 1; t < 500; t++) assert.equal(off.observe(t, { a: { n: 1 } }), null);
});

const canListen = await new Promise<boolean>((res) => {
  const s = net.createServer();
  s.once("error", () => res(false));
  s.listen(0, "127.0.0.1", () => s.close(() => res(true)));
});

test("server: a takeover starts a new run and the state carries the note", { skip: !canListen && "sandbox forbids listening on TCP ports" }, async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-epoch-"));
  const PORT = 19000 + Math.floor(Math.random() * 1000);
  // Share 0: any leader counts, so the run is "decided" after 5 rounds.
  const srv = spawn(process.execPath, ["--import", "tsx", path.join(here, "../src/main.ts")], {
    cwd: path.join(here, ".."),
    env: { ...process.env, MUTATION_BASE_URL: "", ANTHROPIC_API_KEY: "", DARWIN_SETTLER_ACCOUNT: "", DARWIN_SETTLER_KEY: "", PUBLIC_MODE: "1", PORT: String(PORT), HOST: "127.0.0.1", DARWIN_DB: path.join(dir, "t.sqlite"), TICKS: "400", DARWIN_EPOCH_SHARE: "0", DARWIN_EPOCH_HOLD: "5" },
    stdio: "ignore",
  });
  try {
    let st: any = null;
    for (let i = 0; i < 300 && !st?.takeover; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json(); } catch {}
    }
    assert.ok(st?.takeover, "takeover noted");
    assert.equal(st.takeover.tick - st.takeover.since + 1, 5);
    assert.equal(st.takeover.seed, 3);
    assert.notEqual(st.seed, 3, "the next run is a different seed");
    assert.equal(st.startRound, 135, "the new run opens at round 135, like every public run");
    assert.ok(st.tick < st.startRound + 8, "and streams on from there");
    assert.deepEqual(st.epochRule, { share: 0, hold: 5 });
    const chain = await (await fetch(`http://127.0.0.1:${PORT}/api/chain`)).json();
    assert.equal(chain.live.enabled, false, "no settler without its env vars");
  } finally {
    srv.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server: a finished run refuses shocks (409) instead of spending the shared shock on nothing", { skip: !canListen && "sandbox forbids listening on TCP ports" }, async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-done-"));
  const PORT = 20000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ["--import", "tsx", path.join(here, "../src/main.ts")], {
    cwd: path.join(here, ".."),
    env: { ...process.env, MUTATION_BASE_URL: "", ANTHROPIC_API_KEY: "", DARWIN_SETTLER_ACCOUNT: "", DARWIN_SETTLER_KEY: "", PUBLIC_MODE: "", AUTO_RESTART_SEC: "", PORT: String(PORT), HOST: "127.0.0.1", DARWIN_DB: path.join(dir, "t.sqlite"), TICKS: "3" },
    stdio: "ignore",
  });
  try {
    let st: any = null;
    for (let i = 0; i < 300 && !st?.finished; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json(); } catch {}
    }
    assert.ok(st?.finished, "the run finished");
    const r = await fetch(`http://127.0.0.1:${PORT}/api/shock`, { method: "POST", body: JSON.stringify({ kind: "drought" }) });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /finished at round 3/);
  } finally {
    srv.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
