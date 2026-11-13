// "Test your rules": a visitor's rule set against the default rules, on the same seeds, paired by seed.
// The runs are the wind tunnel's (runRules: Gaussian mutation, no LLM); they happen in a worker thread, so the shared
// live run's event loop never waits on them. One job at a time, a short queue, a per-IP limit in public mode.
// Results are cached by rules. A committed grid (results/test-rules.json, `make test-rules-grid`) pre-fills the cache
// for every combination the dashboard's controls can make, so on a slow host the dashboard answers at once.
//
//   npx tsx src/testrules.ts grid    [GRID_WORKERS=4]   -> results/test-rules.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { DEFAULTS, type Config } from "./economy.ts";
import { bootstrapCI, signFlipP, type WindRun } from "./windtunnel.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GRID_PATH = path.resolve(here, "../../results/test-rules.json");

/** The rules a visitor may test, each clamped to a range that keeps a run meaningful and its cost bounded. */
export const TEST_RANGES = {
  auction: { values: ["reputation", "price"] as const },
  marketFee: { min: 0, max: 0.3, digits: 3 },
  upkeep: { min: 0, max: 30_000, digits: 0 }, // micro-credits a round; 6,000 = 0.006 credits
  tasksPerTick: { min: 2, max: 15, digits: 0 },
  forkShare: { min: 0.1, max: 0.8, digits: 2 },
  maxPop: { min: 20, max: 80, digits: 0 },
};
export type TestKey = keyof typeof TEST_RANGES;
export type TestRules = Partial<Pick<Config, TestKey>>;

/** The dashboard's controls snap to these steps; the committed grid holds every combination of them. */
export const GRID = {
  auction: ["reputation", "price"],
  marketFee: [0, 0.05, 0.1, 0.2],
  upkeep: [3000, 6000, 9000, 12_000],
  tasksPerTick: [4, 5, 7, 10],
} as const;

export const PRESETS = [
  { id: "price", label: "Lowest price always wins", rules: { auction: "price" } },
  { id: "fee", label: "10% fee recycled into jobs", rules: { marketFee: 0.1 } },
  { id: "scarce", label: "Fewer jobs: 4 a round", rules: { tasksPerTick: 4 } },
] as const;

export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

/** Validate a visitor's rules: unknown keys and wrong types are refused, numbers are clamped and rounded. */
export function validateRules(input: unknown): { rules: TestRules; clamped: Record<string, { from: number; to: number }> } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HttpError(400, "rules must be an object, e.g. {\"rules\": {\"auction\": \"price\"}}");
  const rules: Record<string, unknown> = {};
  const clamped: Record<string, { from: number; to: number }> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!(k in TEST_RANGES)) throw new HttpError(400, `${k} cannot be tested here; allowed: ${Object.keys(TEST_RANGES).join(", ")}`);
    if (k === "auction") {
      if (v !== "reputation" && v !== "price") throw new HttpError(400, "auction must be reputation or price");
      rules.auction = v;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${k} must be a number`);
    const r = TEST_RANGES[k as Exclude<TestKey, "auction">];
    const f = 10 ** r.digits;
    const to = Math.round(Math.min(r.max, Math.max(r.min, v)) * f) / f;
    if (to !== v) clamped[k] = { from: v, to };
    rules[k] = to;
  }
  // A rule equal to its default changes nothing, so it is dropped: the same rules always give the same cache key.
  for (const k of Object.keys(rules)) if (rules[k] === DEFAULTS[k as TestKey]) delete rules[k];
  return { rules: rules as TestRules, clamped };
}

/** Canonical cache key: the changed rules, sorted. "" is the default rules. */
export const rulesKey = (rules: TestRules) => Object.keys(rules).sort().map((k) => `${k}=${rules[k as TestKey]}`).join(",");

/** The outcomes a test reports, a subset of the wind tunnel's. */
export const TEST_METRICS = [
  { key: "taskSuccess", label: "Jobs done right", unit: "pct" },
  { key: "priceRatio", label: "Price paid, as a share of the reward", unit: "pct" },
  { key: "topFamilyShare", label: "Biggest family's share of agents, at the end", unit: "pct" },
  { key: "population", label: "Agents alive at the end", unit: "n1" },
  { key: "dynastiesLeft", label: "Founding families left, of 36", unit: "n1" },
  { key: "rogueLeaked", label: "Credits the rogue got past the guard", unit: "n0" },
] as const;
export type TestMetric = (typeof TEST_METRICS)[number]["key"];
export type TestRun = Record<TestMetric, number> & { seed: number };

const r4 = (x: number) => +x.toFixed(4);
export function trim(r: WindRun): TestRun {
  return { seed: r.seed, ...Object.fromEntries(TEST_METRICS.map((m) => [m.key, r4(r[m.key])])) } as TestRun;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmt = (unit: string, x: number) => (unit === "pct" ? pct(x) : unit === "n1" ? x.toFixed(1) : x.toFixed(0));

/**
 * Compare paired runs. A change is "clear" when the exact sign-flip test gives p < 0.05, or when every seed moved the
 * same way across at least 5 seeds: with 5 the smallest possible p is 2/32 = 0.0625, so agreement in all 5 is the
 * strongest evidence 5 seeds can give. Anything else is too close to call.
 */
export function summarize(base: TestRun[], mine: TestRun[]) {
  const metrics = TEST_METRICS.map((m) => {
    const d = base.map((b, i) => mine[i][m.key] - b[m.key]);
    const same = d.length >= 5 && (d.every((x) => x > 0) || d.every((x) => x < 0)); // with fewer seeds, agreement is too weak
    const p = signFlipP(d);
    const zero = d.every((x) => Math.abs(x) < 1e-9);
    return {
      key: m.key, label: m.label, unit: m.unit,
      baseline: r4(mean(base.map((r) => r[m.key]))), yours: r4(mean(mine.map((r) => r[m.key]))),
      diff: r4(mean(d)), ci: bootstrapCI(d).map(r4), p: r4(p),
      verdict: zero ? "no change" : p < 0.05 || same ? "clear" : "too close to call",
      perSeed: d.map(r4),
    };
  });
  const g = Object.fromEntries(metrics.map((m) => [m.key, m]));
  const arrow = (k: TestMetric, f: (x: number) => string = (x) => fmt(g[k].unit, x)) => `${f(g[k].baseline)} → ${f(g[k].yours)}`;
  const parts = [
    `successful jobs ${arrow("taskSuccess")}`,
    `buyers paid ${arrow("priceRatio")} of the reward`,
    `the biggest family held ${arrow("topFamilyShare")} of agents`,
    `${arrow("population", (x) => x.toFixed(0))} agents survived`,
  ];
  const headline = metrics.every((m) => m.verdict === "no change")
    ? "Your rules gave the same result as the default rules in every run."
    : `Your rules: ${parts.join(", ")}.`;
  return { headline, metrics };
}

type Task = { seed: number; rules: TestRules };
type Pending = { tasks: Task[]; rounds: number; key: string; resolve: (runs: (TestRun & { ms: number })[]) => void; reject: (e: Error) => void };

export interface TesterOptions {
  seeds: number;
  rounds: number;
  maxQueue: number;
  perIpMs: number; // 0 turns the per-IP limit off
  gridPath?: string;
}

export class RuleTester {
  private cache = new Map<string, TestRun>();
  private grid: { seeds: number[]; rounds: number } | null = null;
  private worker: Worker | null = null;
  private queue: Pending[] = [];
  private current: (Pending & { done: number; startedAt: number }) | null = null;
  private inflight = new Map<string, Promise<unknown>>();
  private lastByIp = new Map<string, number>();
  /** Measured on this server: the last live run's time, ms. */
  lastRunMs: number | null = null;
  lastJobMs: number | null = null;

  constructor(public opts: TesterOptions) {
    if (opts.gridPath) this.loadGrid(opts.gridPath);
  }

  private ck = (rounds: number, seed: number, key: string) => `${rounds}|${seed}|${key}`;

  private loadGrid(file: string) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [key, runs] of Object.entries(j.entries as Record<string, number[][]>)) {
        runs.forEach((vals, i) => this.cache.set(this.ck(j.rounds, j.seeds[i], key), { seed: j.seeds[i], ...Object.fromEntries((j.keys as string[]).map((k, n) => [k, vals[n]])) } as TestRun));
      }
      this.grid = { seeds: j.seeds, rounds: j.rounds };
    } catch {
      this.grid = null;
    }
  }

  private cached(rounds: number, seeds: number[], key: string) {
    const out = seeds.map((s) => this.cache.get(this.ck(rounds, s, key)));
    return out.every(Boolean) ? (out as TestRun[]) : null;
  }

  private remember(rounds: number, key: string, r: TestRun) {
    if (this.cache.size > 20_000) this.cache.delete(this.cache.keys().next().value!); // the grid loads first, so this drops it last
    this.cache.set(this.ck(rounds, r.seed, key), r);
  }

  status() {
    const live = { seeds: this.opts.seeds, rounds: this.opts.rounds };
    return {
      live,
      grid: this.grid ? { ...this.grid, steps: GRID } : null,
      ranges: TEST_RANGES,
      defaults: Object.fromEntries(Object.keys(TEST_RANGES).map((k) => [k, DEFAULTS[k as TestKey]])),
      presets: PRESETS,
      running: this.current ? { done: this.current.done, total: this.current.tasks.length, sec: Math.round((Date.now() - this.current.startedAt) / 1000) } : null,
      queued: this.queue.length,
      maxQueue: this.opts.maxQueue,
      lastRunMs: this.lastRunMs,
      lastJobMs: this.lastJobMs,
      perIpSec: this.opts.perIpMs / 1000,
    };
  }

  /** Test a visitor's rules. `ip` is set in public mode only, where it rate-limits live jobs (cache hits are free). */
  async test(input: unknown, ip?: string) {
    const { rules, clamped } = validateRules(input);
    const key = rulesKey(rules);
    const t0 = Date.now();
    const answer = (seeds: number[], rounds: number, base: TestRun[], mine: TestRun[], source: string, ms: number) => ({
      rules, clamped, seeds, rounds, source, ms, ...summarize(base, mine),
      note: `${seeds.length} runs of ${rounds.toLocaleString("en-US")} rounds, your rules and the default rules on the same seeds, random mutation.` +
        (rounds < 1000 ? " Runs this short show the early market only; the dashboard's steps use 2,000 rounds." : ""),
    });
    if (this.grid) {
      const base = this.cached(this.grid.rounds, this.grid.seeds, ""), mine = this.cached(this.grid.rounds, this.grid.seeds, key);
      if (base && mine) return answer(this.grid.seeds, this.grid.rounds, base, mine, "precomputed", 0);
    }
    const seeds = Array.from({ length: this.opts.seeds }, (_, i) => i + 1), rounds = this.opts.rounds;
    const have = () => [this.cached(rounds, seeds, ""), this.cached(rounds, seeds, key)] as const;
    let [base, mine] = have();
    if (base && mine) return answer(seeds, rounds, base, mine, "cache", 0);
    // The same rules already running or queued: wait for that job instead of starting another.
    let job = this.inflight.get(key);
    if (!job) {
      if (ip !== undefined && this.opts.perIpMs > 0) {
        const wait = (this.lastByIp.get(ip) ?? 0) + this.opts.perIpMs - Date.now();
        if (wait > 0) throw new HttpError(429, `One test every ${this.opts.perIpMs / 1000} s from each visitor. Try again in ${Math.ceil(wait / 1000)} s.`, Math.ceil(wait / 1000));
      }
      if (this.queue.length >= this.opts.maxQueue) throw new HttpError(429, `${this.queue.length + 1} tests are already running or waiting. Try again in a minute.`, 60);
      if (ip !== undefined) {
        this.lastByIp.set(ip, Date.now());
        if (this.lastByIp.size > 5000) this.lastByIp.delete(this.lastByIp.keys().next().value!);
      }
      const tasks: Task[] = [];
      for (const seed of seeds) {
        if (!this.cache.has(this.ck(rounds, seed, ""))) tasks.push({ seed, rules: {} });
        if (key && !this.cache.has(this.ck(rounds, seed, key))) tasks.push({ seed, rules });
      }
      job = this.enqueue(tasks, rounds, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    await job;
    [base, mine] = have();
    if (!base || !mine) throw new HttpError(500, "the test finished without a result; try again");
    return answer(seeds, rounds, base, mine, "live", Date.now() - t0);
  }

  /** Warm the default rules' live runs, so a visitor's first live job runs only their rules. */
  warm() {
    const seeds = Array.from({ length: this.opts.seeds }, (_, i) => i + 1);
    const tasks = seeds.filter((s) => !this.cache.has(this.ck(this.opts.rounds, s, ""))).map((seed) => ({ seed, rules: {} }));
    if (!tasks.length || this.inflight.has("")) return;
    const job = this.enqueue(tasks, this.opts.rounds, "").catch(() => {}).finally(() => this.inflight.delete(""));
    this.inflight.set("", job);
  }

  private enqueue(tasks: Task[], rounds: number, key: string) {
    return new Promise<(TestRun & { ms: number })[]>((resolve, reject) => {
      this.queue.push({ tasks, rounds, key, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.current || !this.queue.length) return;
    const p = this.queue.shift()!;
    this.current = { ...p, done: 0, startedAt: Date.now() };
    const w = this.ensureWorker();
    w.postMessage({ tasks: p.tasks, rounds: p.rounds });
  }

  private finish(err: Error | null, runs?: (TestRun & { ms: number })[]) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    if (err) c.reject(err);
    else {
      for (const [i, r] of runs!.entries()) {
        const { ms, ...run } = r;
        this.remember(c.rounds, rulesKey(c.tasks[i].rules), run);
        this.lastRunMs = ms;
      }
      this.lastJobMs = Date.now() - c.startedAt;
      c.resolve(runs!);
    }
    this.pump();
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const w = testWorker({ resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.unref();
    w.on("message", (m: { type: string; done?: number; runs?: (TestRun & { ms: number })[]; message?: string }) => {
      if (m.type === "progress" && this.current) this.current.done = m.done!;
      else if (m.type === "done") this.finish(null, m.runs);
      else if (m.type === "error") this.finish(new HttpError(500, m.message ?? "the test failed"));
    });
    const dead = (e: Error) => {
      if (this.worker === w) this.worker = null;
      this.finish(new HttpError(500, `the test worker stopped: ${e.message}`));
    };
    w.on("error", dead);
    w.on("exit", (code) => dead(new Error(`exit ${code}`)));
    this.worker = w;
    return w;
  }

  close() {
    void this.worker?.terminate();
    this.worker = null;
  }
}

/** The worker runs TypeScript: tsx's loader hooks do not reach worker threads, so the worker registers them first. */
function testWorker(opts: ConstructorParameters<typeof Worker>[1] = {}) {
  const tsx = import.meta.resolve("tsx/esm/api");
  const file = new URL("./testrules-worker.ts", import.meta.url).href;
  return new Worker(`import(${JSON.stringify(tsx)}).then((t) => { t.register(); return import(${JSON.stringify(file)}); });`, { ...opts, eval: true });
}

/** Every combination of the dashboard's steps, as rules with the defaults dropped. */
export function gridRules(): TestRules[] {
  const out: TestRules[] = [];
  for (const auction of GRID.auction) for (const marketFee of GRID.marketFee) for (const upkeep of GRID.upkeep) for (const tasksPerTick of GRID.tasksPerTick) {
    out.push(validateRules({ auction, marketFee, upkeep, tasksPerTick }).rules);
  }
  return out;
}

async function buildGrid(seeds: number[], rounds: number, workers: number) {
  const all = gridRules();
  const tasks = all.flatMap((rules) => seeds.map((seed) => ({ seed, rules })));
  const out = new Map<string, TestRun[]>();
  let next = 0, done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: workers }, async () => {
    const w = testWorker();
    try {
      while (next < tasks.length) {
        const t = tasks[next++];
        const runs = await new Promise<TestRun[]>((res, rej) => {
          const on = (m: { type: string; runs?: TestRun[]; message?: string }) => {
            if (m.type === "done") (w.off("message", on), res(m.runs!));
            else if (m.type === "error") (w.off("message", on), rej(new Error(m.message)));
          };
          w.on("message", on);
          w.postMessage({ tasks: [t], rounds });
        });
        const key = rulesKey(t.rules);
        out.set(key, [...(out.get(key) ?? []), runs[0]]);
        if (++done % 20 === 0) console.error(`${done}/${tasks.length} runs, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
    } finally {
      await w.terminate();
    }
  }));
  const keys = TEST_METRICS.map((m) => m.key);
  const entries = Object.fromEntries([...out.keys()].sort().map((k) => [k, out.get(k)!.sort((a, b) => a.seed - b.seed).map((r) => keys.map((m) => r[m]))]));
  return { about: "Every combination of the dashboard's 'Test your rules' steps (GRID in sim/src/testrules.ts), each on the same seeds. Generated by `make test-rules-grid`.", rounds, seeds, mutation: "gaussian", keys, entries };
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "grid") {
  const seeds = [1, 2, 3, 4, 5];
  const g = await buildGrid(seeds, Number(process.env.TICKS ?? 2000), Number(process.env.GRID_WORKERS ?? Math.min(4, os.cpus().length)));
  fs.writeFileSync(GRID_PATH, JSON.stringify(g) + "\n");
  console.error(`${Object.keys(g.entries).length} rule sets x ${seeds.length} seeds -> ${GRID_PATH}`);
}
