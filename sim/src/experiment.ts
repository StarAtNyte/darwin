// Multi-seed experiments: `make seeds` (10 seeds, Gaussian mutation, no LLM, free) and `make ablation`
// (Gaussian vs LLM-guided vs mixed on the same seeds). Results go to results/*.json and results/*.md.
//
//   npx tsx src/experiment.ts seeds    [SEEDS=1..10] [TICKS=2000]
//   npx tsx src/experiment.ts ablation [ABLATION_SEEDS=1..5] [TICKS=2000] [MODES=gaussian,llm,mixed]
//
// LLM answers are cached in results/mutations/seed-<seed>-<mode>.json, so the ablation reruns without a key
// (and without spending anything) once recorded. Every live call goes through budget.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Economy } from "./economy.ts";
import { Mutator, type MutationMode } from "./mutator.ts";
import { budget } from "./budget.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.resolve(here, "../../results");

export interface RunSummary {
  seed: number;
  mode: MutationMode;
  ticks: number;
  meanSubcontract: number;
  middlemanShare: number;
  meanMarkup: number;
  specialisation: number;
  extinctions: number;
  maxGeneration: number;
  dynastiesLeft: number;
  rogueBlocked: number;
  rogueAttempts: number;
  rogueLeaked: number;
  population: number;
  meanWealth: number; // credits per living parametric agent, averaged over the run
  taskSuccess: number; // share of settled tasks answered correctly, over the run
  mutations: Record<string, number>;
  lineages: ReturnType<Economy["lineageReport"]>;
  llmCalls: number;
  /** The same metrics at tick 50 (the first full middleman window), as the "start" baseline. */
  start: { meanSubcontract: number; middlemanShare: number; meanMarkup: number; specialisation: number; dynasties: number; population: number };
}

export const START_TICK = 50;

export async function runOne(seed: number, mode: MutationMode, ticks: number, mutator?: Mutator): Promise<RunSummary> {
  const e = new Economy({ seed, mutation: mode }, () => {}, mutator);
  let wealth = 0, ok = 0, settled = 0;
  let start: RunSummary["start"] | undefined;
  for (let i = 0; i < ticks; i++) {
    await e.step();
    if (e.tick === START_TICK) {
      const s = e.lastMetrics;
      start = { meanSubcontract: s.meanSubcontract, middlemanShare: s.middlemanShare, meanMarkup: s.meanMarkup, specialisation: s.specialisation, dynasties: s.dynasties, population: s.population };
    }
    wealth += e.lastMetrics.meanWealth;
    // taskSuccess is over the last 50 ticks; sample it every 50 ticks for a whole-run average.
    if (e.tick % 50 === 0) (ok += e.lastMetrics.taskSuccess), settled++;
  }
  const m = e.lastMetrics;
  return {
    seed, mode, ticks,
    meanSubcontract: m.meanSubcontract,
    middlemanShare: m.middlemanShare,
    meanMarkup: m.meanMarkup,
    specialisation: m.specialisation,
    extinctions: m.deaths,
    maxGeneration: m.maxGeneration,
    dynastiesLeft: m.dynasties,
    rogueBlocked: m.rogueBlocked,
    rogueAttempts: m.rogueAttempts,
    rogueLeaked: m.rogueLeaked,
    population: m.population,
    meanWealth: wealth / ticks,
    taskSuccess: settled ? ok / settled : 0,
    mutations: { ...e.mutationStats },
    lineages: e.lineageReport(),
    llmCalls: e.mutator.calls,
    start: start!,
  };
}

// Two-sided 95% t critical values by degrees of freedom.
const T95: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 14: 2.145, 19: 2.093, 29: 2.045 };
const tcrit = (df: number) => T95[df] ?? (df > 29 ? 1.96 : T95[Object.keys(T95).map(Number).filter((k) => k <= df).pop()!]);

export function stats(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (tcrit(n - 1) * sd) / Math.sqrt(n) : 0;
  return { n, mean, sd, min: Math.min(...xs), max: Math.max(...xs), ci95: [mean - half, mean + half] as [number, number] };
}

type Metric = { key: string; label: string; get: (r: RunSummary) => number; fmt: (x: number) => string };
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number) => x.toFixed(2);
const f0 = (x: number) => x.toFixed(0);
const f1 = (x: number) => x.toFixed(1);
export const METRICS: Metric[] = [
  { key: "meanSubcontract", label: "mean subcontract gene (\"middleman\")", get: (r) => r.meanSubcontract, fmt: f2 },
  { key: "middlemanShare", label: "share of tasks done by middlemen (last 50 ticks)", get: (r) => r.middlemanShare, fmt: pct },
  { key: "meanMarkup", label: "mean bid markup", get: (r) => r.meanMarkup, fmt: f2 },
  { key: "specialisation", label: "specialisation (mean max skill weight)", get: (r) => r.specialisation, fmt: f2 },
  { key: "extinctions", label: "extinctions", get: (r) => r.extinctions, fmt: f0 },
  { key: "maxGeneration", label: "max generation", get: (r) => r.maxGeneration, fmt: f1 },
  { key: "dynastiesLeft", label: "founding dynasties left", get: (r) => r.dynastiesLeft, fmt: f1 },
  { key: "rogueBlocked", label: "rogue payments blocked", get: (r) => r.rogueBlocked, fmt: f0 },
  { key: "rogueAttempts", label: "rogue payments attempted", get: (r) => r.rogueAttempts, fmt: f0 },
  { key: "rogueLeaked", label: "credits leaked by the rogue", get: (r) => r.rogueLeaked, fmt: f0 },
  { key: "population", label: "living parametric agents at the end", get: (r) => r.population, fmt: f1 },
  { key: "meanWealth", label: "mean agent wealth, credits (run average)", get: (r) => r.meanWealth, fmt: f2 },
  { key: "taskSuccess", label: "task success rate (run average)", get: (r) => r.taskSuccess, fmt: pct },
];

const START_METRICS: [string, (s: RunSummary["start"]) => number, (x: number) => string][] = [
  ["mean subcontract gene", (s) => s.meanSubcontract, f2],
  ["share of tasks done by middlemen", (s) => s.middlemanShare, pct],
  ["mean bid markup", (s) => s.meanMarkup, f2],
  ["specialisation", (s) => s.specialisation, f2],
  ["founding dynasties left", (s) => s.dynasties, f1],
  ["living parametric agents", (s) => s.population, f1],
];

const cell = (m: Metric, xs: number[]) => {
  const s = stats(xs);
  return `${m.fmt(s.mean)} (${m.fmt(s.min)} to ${m.fmt(s.max)}; CI ${m.fmt(s.ci95[0])} to ${m.fmt(s.ci95[1])})`;
};

function seedList(spec: string | undefined, dflt: string) {
  const s = spec ?? dflt;
  const m = s.match(/^(\d+)\.\.(\d+)$/);
  if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
  return s.split(",").map(Number);
}

async function seeds() {
  const list = seedList(process.env.SEEDS, "1..10");
  const ticks = Number(process.env.TICKS ?? 2000);
  const runs: RunSummary[] = [];
  for (const s of list) runs.push(await runOne(s, "gaussian", ticks));
  const md = [
    `# DARWIN over ${list.length} seeds (Gaussian mutation, no LLM)`,
    "",
    `Seeds ${list.join(", ")}; ${ticks} ticks each; default rules. Generated by \`make seeds\`. Each cell: mean (min to max; 95% CI of the mean, t-distribution).`,
    "",
    "| metric | mean (range; 95% CI) |",
    "|---|---|",
    ...METRICS.map((m) => `| ${m.label} | ${cell(m, runs.map(m.get))} |`),
    "",
    `Start, at tick ${START_TICK} (the first full 50-tick window), for comparison. Each cell: mean (min to max).`,
    "",
    "| metric | at the start |",
    "|---|---|",
    ...START_METRICS.map(([label, get, fmt]) => {
      const s = stats(runs.map((r) => get(r.start)));
      return `| ${label} | ${fmt(s.mean)} (${fmt(s.min)} to ${fmt(s.max)}) |`;
    }),
    "",
    "Per seed:",
    "",
    `| seed | ${METRICS.map((m) => m.key).join(" | ")} |`,
    `|---|${METRICS.map(() => "---:").join("|")}|`,
    ...runs.map((r) => `| ${r.seed} | ${METRICS.map((m) => m.fmt(m.get(r))).join(" | ")} |`),
    "",
  ].join("\n");
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "seeds-gaussian.json"), JSON.stringify({ ticks, seeds: list, runs, summary: Object.fromEntries(METRICS.map((m) => [m.key, stats(runs.map(m.get))])) }, null, 1) + "\n");
  fs.writeFileSync(path.join(RESULTS, "seeds-gaussian.md"), md);
  console.log(md);
}

async function ablation() {
  const list = seedList(process.env.ABLATION_SEEDS, "1..5");
  const ticks = Number(process.env.TICKS ?? 2000);
  const modes = (process.env.MODES ?? "gaussian,llm,mixed").split(",") as MutationMode[];
  const spent0 = budget.spent();
  const t0 = Date.now();
  const byMode: Record<string, RunSummary[]> = {};
  for (const mode of modes) {
    // Seeds run concurrently; each has its own mutator, call cap and cache file.
    byMode[mode] = await Promise.all(
      list.map(async (s) => {
        const mut = mode === "gaussian" ? undefined : new Mutator({ maxCalls: Number(process.env.DARWIN_MUTATION_MAX_CALLS ?? 600), cachePath: path.join(RESULTS, "mutations", `seed-${s}-${mode}.json`) });
        const r = await runOne(s, mode, ticks, mut);
        mut?.save({ seed: s, mode, ticks });
        console.error(`${mode} seed ${s}: ${JSON.stringify(r.mutations)} calls ${r.llmCalls} failures ${mut?.failures ?? 0}`);
        return r;
      }),
    );
  }
  const spent = budget.spent() - spent0;
  const base = byMode.gaussian;
  const lines = [
    `# Ablation: Gaussian vs LLM-guided mutation`,
    "",
    `Seeds ${list.join(", ")}; ${ticks} ticks; default rules; mutation operator claude-haiku-5-5. Generated by \`make ablation\`. LLM answers are cached in \`results/mutations/\`, so this table regenerates without a key. Each cell: mean (min to max).`,
    `- **gaussian**: every child gets Gaussian-mutated genes (sigma 0.08).`,
    `- **llm**: every child's genes are chosen by Claude from the parent's record and the market; falls back to the Gaussian child on error.`,
    `- **mixed**: a coin flip per fork, so Claude-designed and Gaussian children compete inside the same economy.`,
    "",
    `| metric | ${modes.join(" | ")} |${base ? " llm minus gaussian, paired by seed (95% CI) |" : ""}`,
    `|---|${modes.map(() => "---").join("|")}|${base ? "---|" : ""}`,
  ];
  for (const m of METRICS) {
    const cells = modes.map((mode) => {
      const s = stats(byMode[mode].map(m.get));
      return `${m.fmt(s.mean)} (${m.fmt(s.min)} to ${m.fmt(s.max)})`;
    });
    let diff = "";
    if (base && byMode.llm) {
      const d = stats(list.map((_, i) => m.get(byMode.llm[i]) - m.get(base[i])));
      diff = ` ${m.fmt(d.mean)} (${m.fmt(d.ci95[0])} to ${m.fmt(d.ci95[1])}) |`;
    }
    lines.push(`| ${m.label} | ${cells.join(" | ")} |${diff}`);
  }
  lines.push("", "Fate of forked children by how their genes were made (all seeds pooled; lifespans of the living are counted up to tick " + ticks + "):", "", "| run | children | origin | alive at end | mean lifespan (ticks) | mean earned (credits) | forked a child themselves |", "|---|---:|---|---:|---:|---:|---:|");
  for (const mode of modes) {
    for (const origin of ["gaussian", "llm"] as const) {
      const rs = byMode[mode].map((r) => r.lineages[origin]);
      const born = rs.reduce((s, x) => s + x.born, 0);
      if (!born) continue;
      const w = (k: "meanLifespan" | "meanEarned" | "forkedRate") => rs.reduce((s, x) => s + x[k] * x.born, 0) / born;
      lines.push(`| ${mode} | ${born} | ${origin} | ${rs.reduce((s, x) => s + x.alive, 0)} | ${w("meanLifespan").toFixed(0)} | ${w("meanEarned").toFixed(2)} | ${pct(w("forkedRate"))} |`);
    }
  }
  const calls = Object.fromEntries(modes.map((mode) => [mode, byMode[mode].reduce((s, r) => s + r.llmCalls, 0)]));
  const muts = Object.fromEntries(modes.map((mode) => [mode, byMode[mode].reduce((acc, r) => { for (const [k, v] of Object.entries(r.mutations)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {} as Record<string, number>)]));
  // The table is the same whether the model's answers came live or from the cache, so the file only counts
  // children by designer; this invocation's live calls and spend go to the console.
  const designed = (m: Record<string, number>) => `${(m.llm ?? 0) + (m.cache ?? 0)} by the model (live or cached), ${m.gaussian ?? 0} Gaussian, ${m.fallback ?? 0} Gaussian fallbacks`;
  lines.push("", `Children by designer: ${modes.map((m) => `${m}: ${designed(muts[m])}`).join("; ")}.`, "");
  console.error(`Forks by source: ${modes.map((m) => `${m} ${JSON.stringify(muts[m])}`).join("; ")}. Live Claude calls this invocation: ${JSON.stringify(calls)}, spend $${spent.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
  const md = lines.join("\n");
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "ablation.json"), JSON.stringify({ ticks, seeds: list, modes, runs: byMode }, null, 1) + "\n");
  fs.writeFileSync(path.join(RESULTS, "ablation.md"), md);
  console.log(md);
}

const cmd = process.argv[2];
if (cmd === "seeds") await seeds();
else if (cmd === "ablation") await ablation();
else if (import.meta.url === `file://${process.argv[1]}`) console.log("usage: experiment.ts seeds | ablation");
