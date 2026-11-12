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
delete process.env.ANTHROPIC_API_KEY; // never reach a real API from tests
delete process.env.MUTATION_BASE_URL;

const { Economy } = await import("../src/economy.ts");
const { Mutator, parseChild, RateGate, openAICompatProvider, providerFromEnv, modelLabel } = await import("../src/mutator.ts");
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

// ---------- providers: Anthropic or any OpenAI-compatible endpoint, same validation ----------

test("providerFromEnv: an OpenAI-compatible endpoint wins; Claude is off in public mode unless enabled", () => {
  const nim = { MUTATION_BASE_URL: "https://nim.example/v1", MUTATION_API_KEY: "k", MUTATION_MODEL: "mistralai/mistral-large-4-1t-a52b", ANTHROPIC_API_KEY: "a" };
  const p = providerFromEnv(nim, true)!;
  assert.equal(p.model, "mistralai/mistral-large-4-1t-a52b");
  assert.equal(p.billed, false);
  assert.equal(providerFromEnv({ ANTHROPIC_API_KEY: "a" }, false)!.model, "claude-haiku-5-5");
  assert.equal(providerFromEnv({ ANTHROPIC_API_KEY: "a" }, true), undefined);
  assert.equal(providerFromEnv({ ANTHROPIC_API_KEY: "a", DARWIN_PUBLIC_ANTHROPIC: "1" }, true)!.billed, true);
  assert.equal(providerFromEnv({}, false), undefined);
  assert.throws(() => providerFromEnv({ MUTATION_BASE_URL: "https://x/v1" }, false), /MUTATION_API_KEY/);
});

test("modelLabel names the model that decided", () => {
  assert.equal(modelLabel("claude-haiku-5-5"), "Claude");
  assert.equal(modelLabel(undefined), "Claude");
  assert.equal(modelLabel("mistralai/mistral-large-4-1t-a52b"), "Mistral Large");
  assert.equal(modelLabel("google/gemma-4-31b-it:free"), "Gemma 4 31b");
});

test("RateGate spaces starts under the limit, caps calls in flight, and refuses a long queue", () => {
  let now = 0;
  const g = new RateGate(30, 2, 5000, () => now); // one start per 2 s
  assert.deepEqual(g.acquire(), { wait: 0 });
  assert.deepEqual(g.acquire(), { wait: 2000 });
  assert.deepEqual(g.acquire(), { refused: "busy" });
  g.release();
  g.release();
  assert.deepEqual(g.acquire(), { wait: 4000 });
  assert.deepEqual(g.acquire(), { refused: "rate limit" }); // would start 6 s from now
  g.release();
  const q = new RateGate(30, 10, 5000, () => now);
  for (let i = 0; i < 3; i++) assert.ok("wait" in q.acquire());
  assert.deepEqual(q.acquire(), { refused: "rate limit" }); // would start 6 s from now
  now = 10_000;
  assert.deepEqual(q.acquire(), { wait: 0 });
});

/** A fake /chat/completions endpoint: records requests, answers like the mock operator, optionally slowly. */
function fakeEndpoint(opts: { delayMs?: number; reply?: (ctx: any) => string } = {}) {
  const reqs: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    reqs.push({ url, headers: init.headers as Record<string, string>, body });
    if (opts.delayMs) {
      await new Promise((r, j) => {
        const t = setTimeout(r, opts.delayMs);
        init.signal?.addEventListener("abort", () => (clearTimeout(t), j(new Error("aborted"))));
      });
    }
    const ctx = JSON.parse(body.messages[1].content);
    const g = ctx.parent.genome;
    const content = opts.reply ? opts.reply(ctx) : "Here you go:\n```json\n" + JSON.stringify({ ...g, markup: g.markup + 5, rationale: "rivals undercut, so bid lower" }) + "\n```";
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 80 } }), { status: 200 });
  }) as typeof fetch;
  return { reqs, fetchImpl };
}

test("OpenAI-compatible provider: same prompt, same validation and clamping, model recorded, not billed", async () => {
  fs.writeFileSync(process.env.NEAR_LLM_BUDGET_FILE!, JSON.stringify({ usd: 0 }));
  const ep = fakeEndpoint();
  const provider = openAICompatProvider({ baseUrl: "https://nim.example/v1/", apiKey: "secret", model: "mistralai/mistral-large-4-1t-a52b", reasoningEffort: "low", fetchImpl: ep.fetchImpl });
  const m = new Mutator({ provider, maxCalls: 10 });
  const e = new Economy({ seed: 1 });
  const a = e.alive().find((x) => x.role === "parametric")!;
  const r = await m.propose(e.mutationContext(a, e.marketContext()), parent);
  assert.equal(r.source, "llm");
  assert.equal(r.model, "mistralai/mistral-large-4-1t-a52b");
  assert.equal(r.rationale, "rivals undercut, so bid lower");
  assert.ok(Math.abs(r.genome.markup - Math.min(1, a.genome.markup + 0.25)) < 1e-3, "markup step clipped exactly as for Claude");
  assert.equal(ep.reqs[0].url, "https://nim.example/v1/chat/completions");
  assert.equal(ep.reqs[0].headers.authorization, "Bearer secret");
  assert.equal(ep.reqs[0].body.reasoning_effort, "low");
  assert.match(ep.reqs[0].body.messages[0].content, /mutation operator in DARWIN/);
  assert.equal(budget.spent(), 0, "free provider is not billed");
  assert.equal(provider.gate.inFlight, 0);

  const bad = openAICompatProvider({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl: fakeEndpoint({ reply: () => "I would lower the markup." }).fetchImpl });
  const r2 = await new Mutator({ provider: bad, maxCalls: 10 }).propose(e.mutationContext(a, e.marketContext()), parent);
  assert.equal(r2.source, "fallback");
  assert.deepEqual(r2.genome, parent);
});

test("a slow model times out to the Gaussian child; a long queue is refused instead of waited for", async () => {
  const slow = openAICompatProvider({ baseUrl: "https://x/v1", apiKey: "k", model: "slow/model", fetchImpl: fakeEndpoint({ delayMs: 2000 }).fetchImpl });
  const m = new Mutator({ provider: slow, maxCalls: 10, timeoutMs: 50 });
  const e = new Economy({ seed: 1 });
  const a = e.alive().find((x) => x.role === "parametric")!;
  const t0 = Date.now();
  const r = await m.propose(e.mutationContext(a, e.marketContext()), parent);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.source, "fallback");
  assert.equal(r.why, "timeout");
  assert.equal(slow.gate.inFlight, 0);

  const busy = openAICompatProvider({ baseUrl: "https://x/v1", apiKey: "k", model: "m", rpm: 1, fetchImpl: fakeEndpoint().fetchImpl });
  const mb = new Mutator({ provider: busy, maxCalls: 10 });
  const ctx = e.mutationContext(a, e.marketContext());
  assert.equal((await mb.propose(ctx, parent)).source, "llm");
  const second = mb.start({ ...ctx, tick: ctx.tick + 1 }, parent);
  assert.ok(!(second instanceof Promise), "refused synchronously, no wait");
  assert.equal((second as any).why, "rate limit");
});

test("live server mode: a pending model call never holds up the tick; the child is born when the answer lands", async () => {
  const ep = fakeEndpoint({ delayMs: 30 });
  const provider = openAICompatProvider({ baseUrl: "https://x/v1", apiKey: "k", model: "mistralai/mistral-large-4-1t-a52b", rpm: 1e6, maxInFlight: 100, fetchImpl: ep.fetchImpl });
  const events: any[] = [];
  const e = new Economy({ seed: 3, mutation: "llm" }, (x) => events.push(x), new Mutator({ provider, maxCalls: 1000 }));
  e.deferLiveBirths = true;
  let maxStep = 0;
  for (let i = 0; i < 300; i++) {
    const t0 = Date.now();
    await e.step();
    maxStep = Math.max(maxStep, Date.now() - t0);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 40)); // let answers land, as wall-clock ticks would
  }
  assert.ok(maxStep < 30, `a step never waits for the model (max ${maxStep} ms)`);
  const born = events.filter((x) => x.event === "born" && x.origin === "llm");
  assert.ok(born.length > 3, "children designed by the open model");
  assert.ok(born.every((b) => b.model === "mistralai/mistral-large-4-1t-a52b" && b.rationale));
  assert.equal(e.designers["mistralai/mistral-large-4-1t-a52b"], e.mutationStats.llm);
  assert.ok(e.snapshot().agents.some((a) => a.model === "mistralai/mistral-large-4-1t-a52b"));
  assert.ok(ep.reqs.length >= born.length);
});

test("cache: entries record their model; old files without one replay as Claude; cache hits are free", async () => {
  const cachePath = path.join(dir, "seed-8-llm.json");
  const e = new Economy({ seed: 1 });
  const a = e.alive().find((x) => x.role === "parametric")!;
  const ctx = e.mutationContext(a, e.marketContext());
  const m1 = new Mutator({ provider: openAICompatProvider({ baseUrl: "https://x/v1", apiKey: "k", model: "open/model", fetchImpl: fakeEndpoint().fetchImpl }), maxCalls: 5, cachePath });
  await m1.propose(ctx, parent);
  m1.save({ seed: 8 });
  const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(saved.model, "open/model");
  assert.equal(Object.values<any>(saved.entries)[0].model, "open/model");

  const legacy = path.join(dir, "legacy.json");
  const entries = Object.fromEntries(Object.entries<any>(saved.entries).map(([k, v]) => [k, { genome: v.genome, rationale: v.rationale }]));
  fs.writeFileSync(legacy, JSON.stringify({ format: "darwin-mutations/1", model: "claude-haiku-5-5", entries }));
  const m2 = new Mutator({ maxCalls: 0, cachePath: legacy });
  const r = await m2.propose(ctx, parent);
  assert.equal(r.source, "cache");
  assert.equal(r.model, "claude-haiku-5-5");
});

test("the public site's recorded run: seed 3 replays every child from Claude's recording, as the live server runs it", async () => {
  const cachePath = path.join(path.dirname(new URL(import.meta.url).pathname), "../../results/mutations/seed-3-llm.json");
  const recorded = Object.keys(JSON.parse(fs.readFileSync(cachePath, "utf8")).entries).length;
  const eco = new Economy({ seed: 3 }, () => {});
  eco.setRules({ mutation: "llm" });
  eco.deferLiveBirths = true; // as in main.ts
  eco.mutator = new Mutator({ maxCalls: 0, cachePath });
  for (let t = 0; t < 2000; t++) await eco.step();
  assert.deepEqual(eco.mutationStats, { llm: 0, cache: recorded, gaussian: 0, fallback: 0 });
  assert.equal(eco.designers["claude-haiku-5-5"], recorded);
});
