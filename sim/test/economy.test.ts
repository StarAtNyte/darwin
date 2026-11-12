import { test } from "node:test";
import assert from "node:assert/strict";
import { Economy, gini, mutate, randomGenome } from "../src/economy.ts";
import { Market } from "../src/market.ts";
import { answerHash } from "../src/v2.ts";
import { KINDS, makeTask, referee, rng, scriptedSolve } from "../src/tasks.ts";

test("scripted solver solves every generated task (referee agrees)", () => {
  const r = rng(1);
  for (let i = 0; i < 400; i++) {
    const t = makeTask(r, i, 0);
    assert.ok(referee(t, scriptedSolve(t)), `${t.kind}: ${t.prompt} -> ${scriptedSolve(t)} vs ${t.answer}`);
  }
});

test("market: reputation-weighted award, verified settle and conservation", () => {
  const m = new Market();
  m.fundPool(10_000_000);
  m.registerAgent("a", 1_000_000);
  m.registerAgent("b", 1_000_000);
  m.agents.get("b")!.reputation = 2000;
  const id = m.postTask("arith", 500_000, answerHash(m.peekTaskId(), "42"), 1, 2);
  m.bid("a", id, 300_000);
  m.bid("b", id, 500_000); // 500k/2000 < 300k/1000
  m.now = 1;
  assert.equal(m.closeAuction(id), "b");
  assert.deepEqual(m.submit("b", id, " 42 "), { ok: true });
  m.now = 2;
  assert.equal(m.settle(id).verified, true);
  assert.equal(m.agents.get("b")!.balance, 1_500_000);
  assert.equal(m.totalSupply(), 10_000_000);
});

test("economy runs 400 ticks, conserves supply, evolves, and the rogue leaks nothing", async () => {
  const e = new Economy({ seed: 3 });
  for (let i = 0; i < 400; i++) await e.step(); // step() throws on conservation violation
  const m = e.lastMetrics;
  assert.ok(m.deaths > 0, "some extinction");
  assert.ok(m.maxGeneration >= 2, "some reproduction");
  assert.ok(m.rogueAttempts > 0 && m.rogueBlocked > 0);
  assert.equal(m.rogueLeaked, 0);
  // Each time the rogue also tried its key without the guard; the market refused every one.
  assert.ok(e.rogueStats.bypassRefused > 0);
});

test("mutation keeps genome valid; gini bounds", () => {
  const r = rng(9);
  let g = randomGenome(r);
  for (let i = 0; i < 200; i++) g = mutate(g, r, 0.3);
  assert.ok(Math.abs(g.spec.reduce((a, b) => a + b, 0) - 1) < 1e-9 && g.spec.length === KINDS.length);
  assert.ok(g.markup >= 0.1 && g.markup <= 1);
  assert.equal(gini([1, 1, 1]), 0);
  assert.ok(gini([0, 0, 10]) > 0.6);
});
