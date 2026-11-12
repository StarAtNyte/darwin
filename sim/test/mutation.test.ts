// LLM-guided mutation with a mocked model: validation, fallback, call cap, budget, cache replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlmCall } from "../src/mutator.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-mut-"));
process.env.NEAR_LLM_BUDGET_FILE = path.join(dir, "spend.json");
process.env.NEAR_LLM_BUDGET_USD = "1";
delete process.env.ANTHROPIC_API_KEY; // never reach the real API from tests

const { Economy } = await import("../src/economy.ts");
const { Mutator, parseChild } = await import("../src/mutator.ts");
const { budget } = await import("../src/budget.ts");

const parent = { markup: 0.5, spec: [0.25, 0.25, 0.25, 0.25], risk: 0.2, subcontract: 0.3, reserve: 0.2, forkAt: 2 };
const usage = { input_tokens: 1000, output_tokens: 100 };

/** A fake operator: lower the markup a little, lean into the parent's best kind, say why. */
const mock = (log: string[] = []): LlmCall => async (_sys, user) => {
  const ctx = JSON.parse(user);
  log.push(ctx.parent.id);
  const g = ctx.parent.genome;
  const spec = g.spec.map((x: number, i: number) => (i === g.spec.indexOf(Math.max(...g.spec)) ? x + 0.1 : x));
  return { text: JSON.stringify({ ...g, markup: g.markup - 0.05, spec, rationale: `cut markup, rivals hold ${ctx.market.dynasties[0]?.share}` }), usage };
};

test("parseChild clamps genes to ranges and bounds each step from the parent", () => {
  const { genome, rationale } = parseChild('Sure: {"markup": 5, "spec": [1, 0, 0, 0], "risk": -3, "subcontract": 0.9, "reserve": 0.2, "forkAt": 99, "rationale": "go big"}', parent);
  assert.equal(rationale, "go big");
  assert.ok(Math.abs(genome.markup - 0.75) < 1e-9, "markup moves at most 0.25");
  assert.equal(genome.risk, 0);
  assert.ok(Math.abs(genome.subcontract - 0.6) < 1e-9, "subcontract moves at most 0.3");
  assert.ok(Math.abs(genome.forkAt - 3.2) < 1e-9);
  assert.ok(Math.abs(genome.spec.reduce((a, b) => a + b, 0) - 1) < 1e-9 && genome.spec.length === 4);
  assert.throws(() => parseChild("no json here", parent));
  assert.throws(() => parseChild('{"markup":"x","spec":[1,0,0,0],"risk":0,"subcontract":0,"reserve":0,"forkAt":2,"rationale":"r"}', parent));
  assert.throws(() => parseChild('{"markup":0.5,"spec":[1,0],"risk":0,"subcontract":0,"reserve":0,"forkAt":2,"rationale":"r"}', parent));
  assert.throws(() => parseChild('{"markup":0.5,"spec":[1,0,0,0],"risk":0,"subcontract":0,"reserve":0,"forkAt":2,"rationale":""}', parent));
});

test("mutation is a rule: gaussian, llm or mixed", () => {
  const e = new Economy({ seed: 1 });
  assert.deepEqual(e.setRules({ mutation: "mixed" }), { mutation: "mixed" });
  assert.throws(() => e.setRules({ mutation: "lamarck" }));
});

test("llm mode with no model falls back to exactly the Gaussian run", async () => {
  const a = new Economy({ seed: 5 });
  const b = new Economy({ seed: 5, mutation: "llm" }, () => {}, new Mutator({ maxCalls: 100 }));
  for (let i = 0; i < 300; i++) (await a.step(), await b.step());
  const { mutations: _a, ...ma } = a.lastMetrics;
  const { mutations: mb, ...rest } = b.lastMetrics;
  assert.deepEqual(rest, ma);
  assert.ok(mb.fallback > 0 && mb.llm === 0);
});

test("llm mode: Claude designs children, rationale reaches the born event, spend is recorded, cache replays", async () => {
  const cachePath = path.join(dir, "seed-3-llm.json");
  const before = budget.spent();
  const log: string[] = [];
  const events: any[] = [];
  const m1 = new Mutator({ maxCalls: 1000, call: mock(log), cachePath });
  const e1 = new Economy({ seed: 3, mutation: "llm" }, (e) => events.push(e), m1);
  for (let i = 0; i < 300; i++) await e1.step();
  m1.save({ seed: 3 });
  assert.ok(e1.mutationStats.llm > 5, "some LLM forks");
  assert.equal(e1.mutationStats.fallback, 0);
  const born = events.filter((e) => e.event === "born" && e.origin === "llm");
  assert.equal(born.length, e1.mutationStats.llm);
  assert.match(born[0].rationale, /cut markup/);
  assert.ok(budget.spent() - before > 0, "every call recorded against the budget");
  assert.ok(e1.snapshot().agents.some((a) => a.origin === "llm" && a.rationale));
  assert.equal(e1.lineageReport().llm.born, e1.mutationStats.llm);

  // Replay without a model: identical economy, no calls.
  const m2 = new Mutator({ maxCalls: 0, cachePath });
  const e2 = new Economy({ seed: 3, mutation: "llm" }, () => {}, m2);
  for (let i = 0; i < 300; i++) await e2.step();
  assert.equal(m2.calls, 0);
  assert.equal(e2.mutationStats.cache, e1.mutationStats.llm);
  const { mutations: _x, ...r1 } = e1.lastMetrics;
  const { mutations: _y, ...r2 } = e2.lastMetrics;
  assert.deepEqual(r2, r1);
});

test("malformed output, the call cap and the budget all fall back to Gaussian", async () => {
  const bad: LlmCall = async () => ({ text: "I would lower the markup.", usage });
  const mb = new Mutator({ maxCalls: 1000, call: bad });
  const eb = new Economy({ seed: 4, mutation: "llm" }, () => {}, mb);
  for (let i = 0; i < 200; i++) await eb.step();
  assert.ok(mb.failures > 0 && eb.mutationStats.fallback === mb.failures && eb.mutationStats.llm === 0);

  const mc = new Mutator({ maxCalls: 3, call: mock() });
  const ec = new Economy({ seed: 4, mutation: "llm" }, () => {}, mc);
  for (let i = 0; i < 200; i++) await ec.step();
  assert.equal(mc.calls, 3);
  assert.equal(ec.mutationStats.llm, 3);
  assert.ok(ec.mutationStats.fallback > 0);

  fs.writeFileSync(process.env.NEAR_LLM_BUDGET_FILE!, JSON.stringify({ usd: 1 }));
  const md = new Mutator({ maxCalls: 1000, call: mock() });
  const e = new Economy({ seed: 1 });
  const r = await md.propose(e.mutationContext(e.alive()[5], e.marketContext()), parent);
  assert.equal(r.source, "fallback");
  assert.equal(r.why, "budget");
  assert.equal(md.calls, 0);
});

test("mixed mode forks both kinds of children in one economy", async () => {
  fs.writeFileSync(process.env.NEAR_LLM_BUDGET_FILE!, JSON.stringify({ usd: 0 }));
  const e = new Economy({ seed: 6, mutation: "mixed" }, () => {}, new Mutator({ maxCalls: 1000, call: mock() }));
  for (let i = 0; i < 300; i++) await e.step();
  assert.ok(e.mutationStats.llm > 0 && e.mutationStats.gaussian > 0);
});
