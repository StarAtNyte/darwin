// LLM-guided mutation: when an agent forks, Claude (claude-haiku-5-5) can act as the mutation operator.
// It sees the parent's genome, its record per task kind, and the market (prices, rival dynasties, middlemen),
// and returns a child genome plus a one-line rationale. The genome is validated, clamped to the gene ranges
// and limited to a bounded step from the parent, so it is still a mutation, not a free redesign.
//
// Fallback is the Gaussian child, which the economy draws first on every fork: with no key, over the call cap,
// over budget, or on malformed output, the run continues exactly as a Gaussian run would at that fork.
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
  /** llm: fresh Claude answer; cache: replayed Claude answer; gaussian: by design; fallback: LLM wanted but unavailable. */
  source: "llm" | "cache" | "gaussian" | "fallback";
  rationale?: string;
  why?: string; // reason for a fallback
}

export type LlmCall = (system: string, user: string) => Promise<{ text: string; usage: { input_tokens: number; output_tokens: number } }>;

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
  return async (system, user) => {
    client ??= new Anthropic();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system,
      messages: [{ role: "user", content: user }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const b = res.content.find((x) => x.type === "text");
    return { text: b && b.type === "text" ? b.text : "", usage: res.usage };
  };
}

export interface MutatorOptions {
  /** Live Claude calls allowed this run (0 = replay-only). */
  maxCalls?: number;
  /** JSON cache file: read at start (replay), written on save() unless savePath is set. */
  cachePath?: string;
  /** Where save() writes (also read at start). Lets a live run replay a committed cache without changing it. */
  savePath?: string;
  /** Inject a model call (tests). Defaults to the Anthropic SDK when ANTHROPIC_API_KEY is set. */
  call?: LlmCall;
}

interface CacheEntry {
  genome: GenomeLike;
  rationale: string;
}

export class Mutator {
  readonly maxCalls: number;
  calls = 0;
  failures = 0;
  hits = 0;
  cache: Record<string, CacheEntry> = {};
  private call?: LlmCall;
  private dirty = false;

  constructor(private opts: MutatorOptions = {}) {
    this.maxCalls = opts.maxCalls ?? Number(process.env.DARWIN_MUTATION_MAX_CALLS ?? 400);
    this.call = opts.call ?? (process.env.ANTHROPIC_API_KEY ? anthropicCall() : undefined);
    for (const p of [opts.cachePath, opts.savePath]) {
      if (!p || !fs.existsSync(p)) continue;
      try {
        Object.assign(this.cache, JSON.parse(fs.readFileSync(p, "utf8")).entries ?? {});
      } catch {}
    }
  }

  /** The child genome for one fork. `gaussian` is the precomputed fallback child. */
  async propose(ctx: MutationContext, gaussian: GenomeLike): Promise<MutationResult> {
    const key = `${ctx.tick}:${ctx.parent.id}:${genomeKey(ctx.parent.genome)}`;
    const hit = this.cache[key];
    if (hit) {
      this.hits++;
      return { genome: { ...hit.genome, spec: [...hit.genome.spec] }, source: "cache", rationale: hit.rationale };
    }
    if (!this.call) return { genome: gaussian, source: "fallback", why: "no key" };
    if (this.calls >= this.maxCalls) return { genome: gaussian, source: "fallback", why: "call cap" };
    try {
      budget.check();
    } catch {
      return { genome: gaussian, source: "fallback", why: "budget" };
    }
    this.calls++;
    try {
      const { text, usage } = await this.call(SYSTEM, JSON.stringify(ctx));
      budget.record(usage);
      const child = parseChild(text, ctx.parent.genome);
      this.cache[key] = { genome: roundGenome(child.genome), rationale: child.rationale };
      this.dirty = true;
      // Return the rounded genome so a live run and its replay are bit-identical.
      const g = this.cache[key].genome;
      return { genome: { ...g, spec: [...g.spec] }, source: "llm", rationale: child.rationale };
    } catch (e) {
      this.failures++;
      return { genome: gaussian, source: "fallback", why: (e as Error).message.slice(0, 80) };
    }
  }

  save(meta: Record<string, unknown> = {}) {
    const out = this.opts.savePath ?? this.opts.cachePath;
    if (!out || !this.dirty) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(this.cache).sort(([a], [b]) => Number(a.split(":")[0]) - Number(b.split(":")[0]) || a.localeCompare(b)));
    fs.writeFileSync(out, JSON.stringify({ format: "darwin-mutations/1", model: MODEL, ...meta, entries: sorted }, null, 1) + "\n");
    this.dirty = false;
  }
}
