import { test } from "node:test";
import assert from "node:assert/strict";
import { Economy, SEED } from "../src/economy.ts";
import { RULE_SETS, bootstrapCI, runRules, signFlipP, windtunnel } from "../src/windtunnel.ts";

test("sign-flip test: exact p-values", () => {
  assert.equal(signFlipP([0, 0, 0]), 1);
  // All 10 differences positive: only the all-plus and all-minus flips are as extreme.
  assert.equal(signFlipP(Array(10).fill(1)), 2 / 1024);
  // Symmetric differences: every flip is at least as extreme as the observed mean of 0.5 / 4 ... p is large.
  assert.ok(signFlipP([1, -1, 1, -1.5]) > 0.5);
});

test("bootstrap CI brackets the mean and is reproducible", () => {
  const d = [0.1, 0.2, 0.15, 0.3, 0.05, 0.12, 0.22, 0.18, 0.09, 0.11];
  const [lo, hi] = bootstrapCI(d);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  assert.ok(lo < mean && mean < hi);
  assert.deepEqual(bootstrapCI(d), [lo, hi]);
  assert.deepEqual(bootstrapCI([2, 2, 2]), [2, 2]);
});

test("market fee: each paid settle takes floor(price * fee) back to the pool inside settle (as the v2 contract does); supply conserved", async () => {
  const evs: { event: string; [k: string]: unknown }[] = [];
  const fee = new Economy({ seed: 5, marketFee: 0.2 }, (ev) => evs.push(ev));
  for (let i = 0; i < 100; i++) await fee.step();
  const paid = evs.filter((ev) => ev.event === "settle" && (ev.paid as number) > 0);
  assert.ok(paid.length > 50);
  for (const s of paid) assert.equal(s.fee, Math.floor((s.paid as number) * 0.2));
  assert.equal(fee.market.totalSupply(), fee.cfg.poolCredits * SEED);
  // With no fee (the default) the economy is unchanged: CI checks that `make seeds` reproduces the committed results.
});

test("market fee is a live rule with a range", () => {
  const e = new Economy({ seed: 1 });
  assert.deepEqual(e.setRules({ marketFee: 0.1 }), { marketFee: 0.1 });
  assert.throws(() => e.setRules({ marketFee: 0.9 }), /between 0 and 0.5/);
});

test("rule sets each change one knob, and every one is a valid live rule", () => {
  assert.equal(RULE_SETS[0].id, "baseline");
  assert.deepEqual(RULE_SETS[0].rules, {});
  const e = new Economy({ seed: 1 });
  for (const s of RULE_SETS.slice(1)) {
    assert.equal(Object.keys(s.rules).length, 1, s.id);
    e.setRules(s.rules as Record<string, unknown>); // throws if not tunable or out of range
  }
});

test("wind tunnel: short run is deterministic, conserves supply, and compares paired by seed", async () => {
  const sets = RULE_SETS.filter((s) => s.id === "baseline" || s.id === "price-auction");
  const a = await windtunnel([1, 2], 150, sets);
  const b = await windtunnel([1, 2], 150, sets);
  assert.deepEqual(a.summary, b.summary);
  for (const s of sets) for (const r of a.runs[s.id]) assert.equal(r.supplyDrift, 0);
  const one = await runRules(1, {}, 150);
  assert.deepEqual(one, a.runs.baseline[0]);
  assert.ok(a.vsBaseline["price-auction"].topFamilyShare.p >= 0.5); // two seeds: the smallest possible p is 0.5
});
