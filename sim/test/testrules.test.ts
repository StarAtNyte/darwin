// "Test your rules": validation and clamping, the result's shape, caching, the queue and the per-IP limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { GRID, GRID_PATH, PRESETS, RuleTester, TEST_METRICS, gridRules, rulesKey, summarize, trim, validateRules } from "../src/testrules.ts";
import { runRules } from "../src/windtunnel.ts";

test("test rules: numbers are clamped and rounded, defaults dropped, anything else refused", () => {
  const v = validateRules({ auction: "price", marketFee: 0.9, upkeep: -5, tasksPerTick: 6.6, forkShare: 0.333, maxPop: 50 });
  assert.deepEqual(v.rules, { auction: "price", marketFee: 0.3, upkeep: 0, forkShare: 0.33 });
  // tasksPerTick 6.6 rounds to 7, the default, so it is dropped like maxPop 50.
  assert.deepEqual(v.clamped, { marketFee: { from: 0.9, to: 0.3 }, upkeep: { from: -5, to: 0 }, tasksPerTick: { from: 6.6, to: 7 }, forkShare: { from: 0.333, to: 0.33 } });
  assert.deepEqual(validateRules({ tasksPerTick: 99 }).rules, { tasksPerTick: 15 });
  assert.deepEqual(validateRules({}).rules, {});
  for (const bad of [{ deathFloor: 0.5 }, { mutation: "llm" }, { auction: "cheapest" }, { marketFee: "0.1" }, { upkeep: null }, { tasksPerTick: Infinity }]) {
    assert.throws(() => validateRules(bad), (e: { status: number }) => e.status === 400, JSON.stringify(bad));
  }
  for (const bad of [null, [1], "price", 3]) assert.throws(() => validateRules(bad), /rules must be an object/);
  assert.equal(rulesKey(validateRules({ upkeep: 12000, auction: "price" }).rules), rulesKey(validateRules({ auction: "price", upkeep: 12000 }).rules));
  assert.equal(rulesKey({}), "");
});

test("test rules: summary is paired by seed, with a verdict per outcome and a plain headline", () => {
  const run = (seed: number, v: Partial<Record<string, number>>) => ({ seed, taskSuccess: 0.8, priceRatio: 0.5, topFamilyShare: 0.9, population: 20, dynastiesLeft: 1, rogueLeaked: 0, ...v });
  const base = [1, 2, 3, 4, 5].map((s) => run(s, { topFamilyShare: 0.9 + s / 100 }));
  const mine = [1, 2, 3, 4, 5].map((s) => run(s, { topFamilyShare: 0.6 + s / 100, taskSuccess: s % 2 ? 0.82 : 0.78 }));
  const s = summarize(base, mine);
  assert.deepEqual(s.metrics.map((m) => m.key), TEST_METRICS.map((m) => m.key));
  const g = Object.fromEntries(s.metrics.map((m) => [m.key, m]));
  assert.equal(g.topFamilyShare.verdict, "clear"); // all five seeds moved the same way
  assert.equal(g.topFamilyShare.p, 0.0625); // the smallest p five seeds allow
  assert.equal(g.taskSuccess.verdict, "too close to call");
  assert.equal(g.rogueLeaked.verdict, "no change");
  assert.equal(g.topFamilyShare.perSeed.length, 5);
  assert.ok(g.topFamilyShare.ci[0] <= g.topFamilyShare.diff && g.topFamilyShare.diff <= g.topFamilyShare.ci[1]);
  assert.equal(s.headline, "Your rules: successful jobs 80% → 80%, buyers paid 50% → 50% of the reward, the biggest family held 93% → 63% of agents, 20 → 20 agents survived.");
  assert.match(summarize(base, base).headline, /same result as the default rules/);
});

test("test rules: live job in a worker, then served from the cache; one job per IP per window; a full queue says so", async () => {
  const t = new RuleTester({ seeds: 2, rounds: 60, maxQueue: 1, perIpMs: 60_000 });
  try {
    const a = await t.test({ auction: "price" }, "1.1.1.1");
    assert.equal(a.source, "live");
    assert.deepEqual(a.seeds, [1, 2]);
    assert.equal(a.rounds, 60);
    assert.match(a.note, /^2 runs of 60 rounds/);
    assert.deepEqual(a.rules, { auction: "price" });
    assert.equal(a.metrics.length, TEST_METRICS.length);
    assert.ok(t.lastRunMs! > 0 && t.lastJobMs! >= t.lastRunMs!);
    // The worker's runs equal the wind tunnel's on the main thread.
    const direct = trim(await runRules(2, { auction: "price" }, 60));
    assert.equal(a.metrics[0].yours, +((trim(await runRules(1, { auction: "price" }, 60)).taskSuccess + direct.taskSuccess) / 2).toFixed(4));
    // The same rules again: cached, free, not rate-limited.
    const b = await t.test({ auction: "price" }, "1.1.1.1");
    assert.equal(b.source, "cache");
    assert.deepEqual(b.metrics, a.metrics);
    // New rules from the same visitor inside the window: 429 with the wait.
    await assert.rejects(t.test({ marketFee: 0.2 }, "1.1.1.1"), (e: { status: number; retryAfter: number; message: string }) => e.status === 429 && e.retryAfter > 0 && /One test every 60 s/.test(e.message));
    // Another visitor may run; a third finds the one-slot queue full.
    const c = t.test({ marketFee: 0.2 }, "2.2.2.2");
    const d = t.test({ marketFee: 0.25 }, "3.3.3.3");
    await assert.rejects(t.test({ upkeep: 1000 }, "4.4.4.4"), (e: { status: number; message: string }) => e.status === 429 && /already running or waiting/.test(e.message));
    assert.equal((await c).source, "live");
    assert.equal((await d).source, "live");
  } finally {
    t.close();
  }
});

test("test rules: the committed grid covers every dashboard combination and the presets, and reproduces", async () => {
  const g = JSON.parse(fs.readFileSync(GRID_PATH, "utf8"));
  assert.equal(g.rounds, 2000);
  assert.deepEqual(g.seeds, [1, 2, 3, 4, 5]);
  const combos = GRID.auction.length * GRID.marketFee.length * GRID.upkeep.length * GRID.tasksPerTick.length;
  assert.equal(Object.keys(g.entries).length, combos);
  for (const r of gridRules()) assert.ok(g.entries[rulesKey(r)], rulesKey(r));
  for (const p of PRESETS) assert.ok(g.entries[rulesKey(validateRules(p.rules).rules)], p.id);
  const t = new RuleTester({ seeds: 5, rounds: 2000, maxQueue: 0, perIpMs: 0, gridPath: GRID_PATH });
  const r = await t.test({ auction: "price" });
  assert.equal(r.source, "precomputed");
  assert.equal(r.ms, 0);
  // Spot check: baseline seed 1 recomputed now equals the committed row.
  const one = trim(await runRules(1, {}, 2000));
  assert.deepEqual(g.entries[""][0], g.keys.map((k: keyof typeof one) => one[k]));
});
