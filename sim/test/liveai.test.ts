// Live Claude in a shared run (liveai.ts), with a mocked model: every Nth fork, one call a minute, $0.30 a day.
// No test reaches a real API.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlmCall } from "../src/mutator.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-live-"));
const spend = path.join(dir, "spend.json");
process.env.NEAR_LLM_BUDGET_FILE = spend;
process.env.NEAR_LLM_BUDGET_USD = "5";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.MUTATION_BASE_URL;

const { LiveGate, liveAiFromEnv, LIVE_DAILY_CAP_USD } = await import("../src/liveai.ts");
const { Mutator, anthropicProvider } = await import("../src/mutator.ts");
const { budget } = await import("../src/budget.ts");

const T0 = Date.UTC(2026, 10, 13, 12);
const reset = (usd = 0, dayUsd = 0, day = "2026-11-13") => fs.writeFileSync(spend, JSON.stringify({ usd, day, dayUsd }));

test("live AI is off unless DARWIN_LIVE_AI=1 and a key are both set", () => {
  assert.equal(liveAiFromEnv({}), null);
  assert.equal(liveAiFromEnv({ DARWIN_LIVE_AI: "1" }), null);
  assert.equal(liveAiFromEnv({ ANTHROPIC_API_KEY: "k" }), null);
  const fake = anthropicProvider(async () => ({ text: "", usage: { input_tokens: 0, output_tokens: 0 } }));
  const on = liveAiFromEnv({ DARWIN_LIVE_AI: "1", ANTHROPIC_API_KEY: "k", DARWIN_LIVE_AI_EVERY: "4" }, fake)!;
  assert.equal(on.gate.every, 4);
  assert.equal(on.provider.model, "claude-haiku-5-5");
});

test("the gate's limits cannot be loosened past one call a minute and $0.30 a day", () => {
  const g = new LiveGate(1, 1000, 50);
  assert.equal(g.minIntervalMs, 60_000);
  assert.equal(g.dailyCapUsd, LIVE_DAILY_CAP_USD);
});

test("every Nth fork, and at most one call per 60 s", () => {
  reset();
  let t = T0;
  const g = new LiveGate(3, 60_000, 0.3, () => t);
  const turns = Array.from({ length: 9 }, () => g.take());
  assert.deepEqual(turns, [false, false, true, false, false, false, false, false, false], "forks 6 and 9 fall inside the minute");
  t += 60_000;
  assert.deepEqual([g.take(), g.take(), g.take()], [false, false, true], "fork 12, a minute later");
  assert.equal(g.calls, 2);
});

test("the daily cap: no call once today's spend would pass $0.30; a new UTC day resets it", () => {
  let t = T0;
  const g = new LiveGate(1, 60_000, 0.3, () => t);
  reset(0.2, 0.299);
  assert.equal(g.take(), false, "0.299 + one call's reserve passes 0.30");
  reset(0.2, 0.25);
  assert.equal(g.take(), true);
  budget.add(0.06, t);
  assert.ok(budget.spentToday(t) > 0.3 && budget.spentToday(t) < 0.32);
  t += 60_000;
  assert.equal(g.take(), false, "over the cap");
  t += 24 * 3600_000;
  assert.equal(budget.spentToday(t), 0);
  assert.equal(g.take(), true, "next day");
});

test("the overall budget cap still applies", () => {
  reset(4.999, 0);
  const g = new LiveGate(1, 60_000, 0.3, () => T0);
  assert.equal(g.take(), false);
});

test("a mutator with the gate: live turns ask the model even on a cache hit, other forks replay, and spend is recorded", async () => {
  reset();
  let t = T0;
  const calls: string[] = [];
  const call: LlmCall = async (_s, user) => {
    const ctx = JSON.parse(user);
    calls.push(ctx.parent.id);
    return { text: JSON.stringify({ ...ctx.parent.genome, markup: ctx.parent.genome.markup - 0.01, rationale: "live answer" }), usage: { input_tokens: 2000, output_tokens: 300 } };
  };
  const genome = { markup: 0.5, spec: [0.25, 0.25, 0.25, 0.25], risk: 0.2, subcontract: 0.3, reserve: 0.2, forkAt: 2 };
  const { genomeKey } = await import("../src/mutator.ts");
  const cachePath = path.join(dir, "rec.json");
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < 4; i++) entries[`${i}:a${i}:${genomeKey(genome)}`] = { genome, rationale: "recorded answer", model: "claude-haiku-5-5" };
  fs.writeFileSync(cachePath, JSON.stringify({ model: "claude-haiku-5-5", entries }));
  const m = new Mutator({ provider: anthropicProvider(call), maxCalls: 1000, cachePath });
  m.live = new LiveGate(2, 60_000, 0.3, () => t);
  const ctx = (i: number) => ({ tick: i, parent: { id: `a${i}`, genome, balance: 3, generation: 0, age: 1, reputation: 1, wins: 0, losses: 0, earned: 0, subcontracted: 0, selfSolved: 0, byKind: {} }, market: { population: 36, maxPop: 50, upkeepPerTick: 0.006, deathFloor: 0.12, auction: "reputation", middlemanShare: 0, byKind: {}, dynasties: [], shocks: [] } });
  const r0 = await m.start(ctx(0), genome);
  assert.equal(r0.source, "cache");
  const r1 = await m.start(ctx(1), genome);
  assert.equal(r1.source, "llm", "the 2nd fork is a live turn");
  assert.equal(r1.rationale, "live answer");
  assert.equal(calls.length, 1);
  assert.ok(budget.spentToday(Date.now()) > 0, "the call's cost is in the spend file");
  assert.equal((await m.start(ctx(2), genome)).source, "cache");
  assert.equal((await m.start(ctx(3), genome)).source, "cache", "4th fork is a live turn, but inside the minute: replay");
  t += 60_000;
  const miss = await m.start(ctx(9), genome);
  assert.equal(miss.source, "fallback", "a cache miss on a non-live turn never calls the model");
  assert.equal(miss.why, "not a live turn");
  assert.equal(calls.length, 1);
});
