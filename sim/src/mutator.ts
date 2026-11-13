// LLM-guided mutation: when an agent forks, a language model can act as the mutation operator: Claude
// (claude-haiku-5-5, billed against budget.ts) or any OpenAI-compatible endpoint (MUTATION_BASE_URL, e.g. a free
// open model on NVIDIA NIM or OpenRouter; see providerFromEnv).
// It sees the parent's genome, its record per task kind, and the market (prices, rival dynasties, middlemen),
// and returns a child genome plus a one-line rationale. The genome is validated, clamped to the gene ranges
// and limited to a bounded step from the parent, so it is still a mutation, not a free redesign.
//
// Fallback is the Gaussian child, which the economy draws first on every fork: with no key, over the call cap,
// over budget, rate-limited, timed out, or on malformed output, the run continues exactly as a Gaussian run would.
// Per fork: cache hit -> live call (client-side rate limit + timeout) -> Gaussian. Validation is the same for every
// provider, and every child records the model that designed it.
// Every LLM answer is cached per run (key = tick, parent, parent genome), so a run recorded with a key replays
// without one: same seed, same mode, same cache file -> same economy.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { budget, MODEL } from "./budget.ts";
import { KINDS } from "./tasks.ts";

export type MutationMode = "gaussian" | "llm" | "mixed";
export const MUTATION_MODES: readonly MutationMode[] = ["gaussian", "llm", "mixed"];

export interface GenomeLike {
  markup: number;
  spec: number[];
  risk: number;
  subcontract: number;
  reserve: number;
  forkAt: number;
}

export interface MutationContext {
  tick: number;
  parent: {
    id: string;
    genome: GenomeLike;
    balance: number; // credits
    generation: number;
    age: number;
    reputation: number;
    wins: number;
    losses: number;
    earned: number; // credits
    subcontracted: number;
    selfSolved: number;
    byKind: Record<string, { won: number; ok: number; earned: number }>;
  };
  market: {
    population: number;
    maxPop: number;
    upkeepPerTick: number; // credits
    deathFloor: number; // credits
    auction: string;
    middlemanShare: number;
    byKind: Record<string, { tasks: number; meanPriceRatio: number; successRate: number; subcontractedShare: number }>;
    dynasties: { founder: string; share: number; own: boolean; meanMarkup: number; meanSubcontract: number }[];
    shocks: string[];
  };
}

export interface MutationResult {
  genome: GenomeLike;
  /** llm: fresh model answer; cache: replayed model answer; gaussian: by design; fallback: LLM wanted but unavailable. */
  source: "llm" | "cache" | "gaussian" | "fallback";
  rationale?: string;
  why?: string; // reason for a fallback
  /** Model id that designed the child (llm and cache only). */
  model?: string;
}

export type LlmCall = (system: string, user: string, signal?: AbortSignal) => Promise<{ text: string; usage: { input_tokens: number; output_tokens: number } }>;

/** A model that can act as the mutation operator. */
export interface MutationProvider {
  /** Model id, recorded on every child and cache entry ("claude-haiku-5-5", "mistralai/mistral-large-4-1t-a52b"). */
  model: string;
  /** True when calls cost money and go through budget.ts (Anthropic). Free endpoints are bounded by the call cap only. */
  billed: boolean;
  call: LlmCall;
  /** Shared client-side rate limit, so every run in this process stays under the provider's limit. */
  gate: RateGate;
}

/** Short display name for a model id: "Claude", "Mistral Large", "Gemma 4 31b". */
export function modelLabel(id: string | undefined): string {
  if (!id) return "Claude"; // entries cached before models were recorded are all claude-haiku-5-5
  if (/claude/i.test(id)) return "Claude";
  if (/mistral-large/i.test(id)) return "Mistral Large";
  const name = id.split("/").pop()!.replace(/:free$/, "").replace(/-(it|instruct|chat)$/i, "");
  return name.split(/[-_]/).map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/**
 * Client-side rate limit: starts are spaced 60/rpm s apart, at most maxInFlight at once, and a call that would
 * have to queue longer than maxQueueMs is refused (the fork falls back to Gaussian instead of waiting).
 */
export class RateGate {
  inFlight = 0;
  private next = 0;
  constructor(readonly rpm: number, readonly maxInFlight = 4, readonly maxQueueMs = 5000, private now = () => Date.now()) {}
  /** Reserve a slot: ms to wait before starting, or a reason the call is refused. */
  acquire(): { wait: number } | { refused: string } {
    if (this.inFlight >= this.maxInFlight) return { refused: "busy" };
    const t = this.now();
    const start = Math.max(t, this.next);
    if (start - t > this.maxQueueMs) return { refused: "rate limit" };
    this.next = start + 60_000 / this.rpm;
    this.inFlight++;
    return { wait: start - t };
  }
  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

const STEP = { markup: 0.25, risk: 0.3, subcontract: 0.3, reserve: 0.3, forkAt: 1.2, spec: 0.3 };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const normalise = (v: number[]) => {
  const s = v.reduce((a, b) => a + Math.max(0.01, b), 0);
  return v.map((x) => Math.max(0.01, x) / s);
};
const near = (x: number, p: number, d: number) => clamp(x, p - d, p + d);

export const SYSTEM = `You are the mutation operator in DARWIN, an evolving economy of trading agents. A parent agent is forking; you design its child's genome.
Mechanics: tasks of 4 kinds (${KINDS.join(", ")}) are auctioned each tick. A bid is markup*reward. Under the "reputation" auction the lowest price*1000/reputation wins; reputation rises with correct work and falls with wrong work. Doing a task yourself succeeds with probability ~ base(difficulty) + 0.9*spec[kind] - 0.1, so specialists are accurate in their kind. A winner may instead subcontract the task to a capacity-limited solver for ~0.6*solver_markup*reward and keep the spread. Every agent pays upkeep each tick and dies below the death floor. Agents fork when balance > forkAt credits, giving the child a share of their balance.
Genes and ranges: markup 0.1-1 (bid fraction of reward), spec 4 weights summing to 1 (preference and skill per kind, order ${KINDS.join(",")}), risk 0-1 (bidding outside specialty), subcontract 0-1 (propensity to resell won work), reserve 0-1 (stop bidding below reserve credits), forkAt 1.3-6 (fork threshold in credits).
Each gene may move at most: markup ${STEP.markup}, risk ${STEP.risk}, subcontract ${STEP.subcontract}, reserve ${STEP.reserve}, forkAt ${STEP.forkAt}, each spec weight ${STEP.spec}. Larger moves are clipped.
Aim for a child that survives and out-earns rival dynasties given the evidence. Reply with JSON only: {"markup":n,"spec":[n,n,n,n],"risk":n,"subcontract":n,"reserve":n,"forkAt":n,"rationale":"one plain sentence, at most 20 words, naming the evidence"}`;

const SCHEMA = {
  type: "object",
  properties: {
    markup: { type: "number" },
    spec: { type: "array", items: { type: "number" } },
    risk: { type: "number" },
    subcontract: { type: "number" },
    reserve: { type: "number" },
    forkAt: { type: "number" },
    rationale: { type: "string" },
  },
  required: ["markup", "spec", "risk", "subcontract", "reserve", "forkAt", "rationale"],
  additionalProperties: false,
};

/** Parse and validate a model answer; returns the clamped child genome or throws. */
export function parseChild(text: string, parent: GenomeLike): { genome: GenomeLike; rationale: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object");
  const j = JSON.parse(m[0]);
  const num = (k: string) => {
    const v = Number(j[k]);
    if (!Number.isFinite(v)) throw new Error(`gene ${k} not a number`);
    return v;
  };
  if (!Array.isArray(j.spec) || j.spec.length !== KINDS.length) throw new Error("spec must have 4 weights");
  const spec = j.spec.map((x: unknown, i: number) => {
    const v = Number(x);
    if (!Number.isFinite(v)) throw new Error("spec weight not a number");
    return near(clamp(v, 0, 1), parent.spec[i], STEP.spec);
  });
  const rationale = String(j.rationale ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!rationale) throw new Error("no rationale");
  return {
    genome: {
      markup: clamp(near(num("markup"), parent.markup, STEP.markup), 0.1, 1),
      spec: normalise(spec),
      risk: clamp(near(num("risk"), parent.risk, STEP.risk), 0, 1),
      subcontract: clamp(near(num("subcontract"), parent.subcontract, STEP.subcontract), 0, 1),
      reserve: clamp(near(num("reserve"), parent.reserve, STEP.reserve), 0, 1),
      forkAt: clamp(near(num("forkAt"), parent.forkAt, STEP.forkAt), 1.3, 6),
    },
    rationale,
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const roundGenome = (g: GenomeLike) => ({ markup: r3(g.markup), spec: g.spec.map(r3), risk: r3(g.risk), subcontract: r3(g.subcontract), reserve: r3(g.reserve), forkAt: r3(g.forkAt) });

/** Stable short hash of a genome, so a cached answer is only replayed for the same parent. */
export function genomeKey(g: GenomeLike) {
  const s = JSON.stringify(roundGenome(g));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function anthropicCall(): LlmCall {
  let client: Anthropic | undefined;
  return async (system, user, signal) => {
    client ??= new Anthropic();
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1500,
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system,
        messages: [{ role: "user", content: user }],
      } as Anthropic.MessageCreateParamsNonStreaming,
      { signal },
    );
    const b = res.content.find((x) => x.type === "text");
    return { text: b && b.type === "text" ? b.text : "", usage: res.usage };
  };
}

/** Any /chat/completions endpoint (NVIDIA NIM, OpenRouter, ...). The reply goes through the same parseChild. */
export function openAICompatCall(opts: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch; maxTokens?: number; reasoningEffort?: string }): LlmCall {
  const f = opts.fetchImpl ?? fetch;
  return async (system, user, signal) => {
    const res = await f(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        // Reasoning models (Mistral Large on NIM) spend most of this thinking before the JSON.
        max_tokens: opts.maxTokens ?? 4000,
        temperature: 0.4,
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
        messages: [
          { role: "system", content: `${system}\nJSON schema of the reply: ${JSON.stringify(SCHEMA)}` },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = j.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("empty reply");
    return { text, usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 } };
  };
}

/** Claude: bounded by the dollar budget, not rate-limited client-side (the ablation runs seeds concurrently). */
export function anthropicProvider(call: LlmCall = anthropicCall()): MutationProvider {
  return { model: MODEL, billed: true, call, gate: new RateGate(Infinity, Infinity) };
}

export function openAICompatProvider(opts: { baseUrl: string; apiKey: string; model: string; rpm?: number; maxInFlight?: number; reasoningEffort?: string; fetchImpl?: typeof fetch }): MutationProvider {
  return { model: opts.model, billed: false, call: openAICompatCall(opts), gate: new RateGate(opts.rpm ?? 30, opts.maxInFlight ?? 8, 10_000) };
}

/**
 * The mutation operator's model from the environment. MUTATION_BASE_URL + MUTATION_API_KEY + MUTATION_MODEL select
 * an OpenAI-compatible endpoint (optional: MUTATION_RPM, default 30, under NIM's ~40/min; MUTATION_MAX_INFLIGHT,
 * default 12; MUTATION_REASONING_EFFORT, e.g. "low" for Mistral Large). Otherwise ANTHROPIC_API_KEY selects Claude.
 * In a public deployment Claude is off unless DARWIN_PUBLIC_ANTHROPIC=1, so visitors never spend credit.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env, publicMode = env.PUBLIC_MODE === "1"): MutationProvider | undefined {
  if (env.MUTATION_BASE_URL) {
    if (!env.MUTATION_API_KEY || !env.MUTATION_MODEL) throw new Error("MUTATION_BASE_URL needs MUTATION_API_KEY and MUTATION_MODEL");
    return openAICompatProvider({
      baseUrl: env.MUTATION_BASE_URL,
      apiKey: env.MUTATION_API_KEY,
      model: env.MUTATION_MODEL,
      rpm: Number(env.MUTATION_RPM ?? 30),
      maxInFlight: Number(env.MUTATION_MAX_INFLIGHT ?? 12),
      reasoningEffort: env.MUTATION_REASONING_EFFORT || undefined,
    });
  }
  if (env.ANTHROPIC_API_KEY && (!publicMode || env.DARWIN_PUBLIC_ANTHROPIC === "1")) return anthropicProvider();
  return undefined;
}

export interface MutatorOptions {
  /** Live model calls allowed this run (0 = replay-only). */
  maxCalls?: number;
  /** JSON cache file: read at start (replay), written on save() unless savePath is set. */
  cachePath?: string;
  /** Where save() writes (also read at start). Lets a live run replay a committed cache without changing it. */
  savePath?: string;
  /** Inject a billed Claude call (tests). Shorthand for provider: anthropicProvider(call). */
  call?: LlmCall;
  /** The model to call on a cache miss. Defaults to providerFromEnv(). */
  provider?: MutationProvider;
  /** Give up on a live call after this long and use the Gaussian child (MUTATION_TIMEOUT_SEC, default 90 s). */
  timeoutMs?: number;
}

interface CacheEntry {
  genome: GenomeLike;
  rationale: string;
  /** Model that designed it; older files record it once at the top level. */
  model?: string;
}

export class Mutator {
  readonly maxCalls: number;
  calls = 0;
  failures = 0;
  hits = 0;
  cache: Record<string, CacheEntry> = {};
  readonly provider?: MutationProvider;
  readonly timeoutMs: number;
  /**
   * Live AI in a shared run (liveai.ts): when set, the model is asked only on the forks this gate allows, even when
   * the recording has an answer, and never on any other fork. Unset: cache, then a live call, then Gaussian.
   */
  live?: { take(): boolean };
  private dirty = false;

  constructor(private opts: MutatorOptions = {}) {
    this.maxCalls = opts.maxCalls ?? Number(process.env.DARWIN_MUTATION_MAX_CALLS ?? 400);
    this.provider = opts.provider ?? (opts.call ? anthropicProvider(opts.call) : providerFromEnv());
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.MUTATION_TIMEOUT_SEC ?? 90) * 1000;
    for (const p of [opts.cachePath, opts.savePath]) {
      if (!p || !fs.existsSync(p)) continue;
      try {
        const file = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const [k, v] of Object.entries((file.entries ?? {}) as Record<string, CacheEntry>)) this.cache[k] = { ...v, model: v.model ?? file.model ?? MODEL };
      } catch {}
    }
  }

  /** The child genome for one fork. `gaussian` is the precomputed fallback child. */
  async propose(ctx: MutationContext, gaussian: GenomeLike): Promise<MutationResult> {
    return this.start(ctx, gaussian);
  }

  /**
   * Like propose, but answers synchronously when no live call is needed (cache hit or immediate fallback),
   * so a caller that must not wait (the live server) can tell a pending model call apart.
   */
  start(ctx: MutationContext, gaussian: GenomeLike): MutationResult | Promise<MutationResult> {
    const key = `${ctx.tick}:${ctx.parent.id}:${genomeKey(ctx.parent.genome)}`;
    const hit = this.cache[key];
    const p = this.provider;
    if (this.live && p && this.live.take() && this.calls < this.maxCalls) {
      const slot = p.gate.acquire();
      if (!("refused" in slot)) {
        this.calls++;
        return this.ask(p, slot.wait, key, ctx, gaussian);
      }
    }
    if (hit) {
      this.hits++;
      return { genome: { ...hit.genome, spec: [...hit.genome.spec] }, source: "cache", rationale: hit.rationale, model: hit.model };
    }
    if (this.live) return { genome: gaussian, source: "fallback", why: "not a live turn" };
    if (!p) return { genome: gaussian, source: "fallback", why: "no key" };
    if (this.calls >= this.maxCalls) return { genome: gaussian, source: "fallback", why: "call cap" };
    if (p.billed) {
      try {
        budget.check();
      } catch {
        return { genome: gaussian, source: "fallback", why: "budget" };
      }
    }
    const slot = p.gate.acquire();
    if ("refused" in slot) return { genome: gaussian, source: "fallback", why: slot.refused };
    this.calls++;
    return this.ask(p, slot.wait, key, ctx, gaussian);
  }

  private async ask(p: MutationProvider, wait: number, key: string, ctx: MutationContext, gaussian: GenomeLike): Promise<MutationResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const { text, usage } = await p.call(SYSTEM, JSON.stringify(ctx), ac.signal);
      if (p.billed) budget.record(usage);
      const child = parseChild(text, ctx.parent.genome);
      this.cache[key] = { genome: roundGenome(child.genome), rationale: child.rationale, model: p.model };
      this.dirty = true;
      // Return the rounded genome so a live run and its replay are bit-identical.
      const g = this.cache[key].genome;
      return { genome: { ...g, spec: [...g.spec] }, source: "llm", rationale: child.rationale, model: p.model };
    } catch (e) {
      this.failures++;
      return { genome: gaussian, source: "fallback", why: ac.signal.aborted ? "timeout" : (e as Error).message.slice(0, 80) };
    } finally {
      clearTimeout(timer);
      p.gate.release();
    }
  }

  save(meta: Record<string, unknown> = {}) {
    const out = this.opts.savePath ?? this.opts.cachePath;
    if (!out || !this.dirty) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(this.cache).sort(([a], [b]) => Number(a.split(":")[0]) - Number(b.split(":")[0]) || a.localeCompare(b)));
    const models = [...new Set(Object.values(this.cache).map((e) => e.model ?? MODEL))];
    fs.writeFileSync(out, JSON.stringify({ format: "darwin-mutations/1", model: models.length === 1 ? models[0] : models.join(", "), ...meta, entries: sorted }, null, 1) + "\n");
    this.dirty = false;
  }
}
