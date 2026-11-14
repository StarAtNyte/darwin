// The wind tunnel: test a market's rules against an evolving population before deploying them on NEAR.
// Runs each rule set below over the same seeds (Gaussian mutation, no LLM, no key) and compares every outcome
// with the baseline rules, paired by seed: mean difference, 95% bootstrap CI, sign-flip p-value (exact or Monte Carlo).
//
//   npx tsx src/windtunnel.ts    [SEEDS=1..30] [TICKS=2000]   -> results/windtunnel.{json,md}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Economy, SEED, type Config } from "./economy.ts";
import { rng } from "./tasks.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.resolve(here, "../../results");

export interface RuleSet {
  id: string;
  label: string;
  /** The question a market designer would ask. */
  question: string;
  rules: Partial<Config>;
}

/** Each set changes one knob from the baseline, so a difference is attributable to that knob. */
export const RULE_SETS: RuleSet[] = [
  { id: "baseline", label: "Baseline", question: "The reference: reputation-weighted auction, upkeep 0.006 credits a tick, 7 tasks a tick, solvers resell 3 jobs a tick, no fee.", rules: {} },
  { id: "price-auction", label: "Lowest price wins", question: "What if the auction ignores reputation and the lowest bid wins?", rules: { auction: "price" } },
  { id: "market-fee", label: "10% market fee", question: "What does a 10% fee on every paid task (back to the pool) do?", rules: { marketFee: 0.1 } },
  { id: "high-rent", label: "Double upkeep", question: "What if staying listed costs twice as much (upkeep 0.012 a tick)?", rules: { upkeep: 12_000 } },
  { id: "scarce-demand", label: "Scarce demand", question: "What if buyers post 4 tasks a tick instead of 7?", rules: { tasksPerTick: 4 } },
  { id: "solver-capacity", label: "Double solver capacity", question: "What if the honest solvers can take 6 resold jobs a tick instead of 3?", rules: { solverSubCap: 6 } },
];

export interface WindRun {
  seed: number;
  topFamilyShare: number; // largest founding family's share of living agents, at the end
  dynastiesLeft: number;
  gini: number; // wealth inequality among living agents, at the end
  middlemanShare: number; // run average
  priceRatio: number; // paid price / reward, run average
  meanMarkup: number; // markup gene, at the end
  taskSuccess: number; // run average
  population: number; // living agents at the end
  extinctions: number;
  meanWealth: number; // credits per living agent, run average
  rogueBlocked: number;
  rogueAttempts: number;
  rogueLeaked: number;
  supplyDrift: number; // max |total supply - initial supply| seen at any tick, micro-credits
}

export async function runRules(seed: number, rules: Partial<Config>, ticks: number): Promise<WindRun> {
  const e = new Economy({ seed, mutation: "gaussian", ...rules });
  const supply0 = e.cfg.poolCredits * SEED;
  let drift = 0, windows = 0, mid = 0, price = 0, ok = 0, wealth = 0;
  for (let i = 0; i < ticks; i++) {
    await e.step();
    drift = Math.max(drift, Math.abs(e.market.totalSupply() - supply0));
    wealth += e.lastMetrics.meanWealth;
    if (e.tick % 50 === 0) {
      const m = e.lastMetrics;
      windows++;
      mid += m.middlemanShare;
      price += m.priceRatio;
      ok += m.taskSuccess;
    }
  }
  const m = e.lastMetrics;
  return {
    seed,
    topFamilyShare: m.topFamilyShare,
    dynastiesLeft: m.dynasties,
    gini: m.gini,
    middlemanShare: mid / windows,
    priceRatio: price / windows,
    meanMarkup: m.meanMarkup,
    taskSuccess: ok / windows,
    population: m.population,
    extinctions: m.deaths,
    meanWealth: wealth / ticks,
    rogueBlocked: m.rogueBlocked,
    rogueAttempts: m.rogueAttempts,
    rogueLeaked: m.rogueLeaked,
    supplyDrift: drift,
  };
}

type Key = Exclude<keyof WindRun, "seed">;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
const f2 = (x: number) => x.toFixed(2);
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const f1 = (x: number) => x.toFixed(1);
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const f0 = (x: number) => x.toFixed(0);
const s0 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;

export const WIND_METRICS: { key: Key; group: string; label: string; fmt: (x: number) => string; diff: (x: number) => string }[] = [
  { key: "topFamilyShare", group: "monopoly", label: "largest family's share of agents", fmt: pct, diff: pts },
  { key: "dynastiesLeft", group: "monopoly", label: "founding families left (of 36)", fmt: f1, diff: s1 },
  { key: "gini", group: "monopoly", label: "wealth Gini", fmt: f2, diff: s2 },
  { key: "middlemanShare", group: "middlemen", label: "share of tasks resold to a solver", fmt: pct, diff: pts },
  { key: "priceRatio", group: "price", label: "price paid / task reward", fmt: f2, diff: s2 },
  { key: "meanMarkup", group: "price", label: "markup gene at the end", fmt: f2, diff: s2 },
  { key: "taskSuccess", group: "quality", label: "task success rate", fmt: pct, diff: pts },
  { key: "population", group: "survival", label: "living agents at the end (cap 50)", fmt: f1, diff: s1 },
  { key: "meanWealth", group: "survival", label: "mean agent wealth, credits", fmt: f2, diff: s2 },
  { key: "extinctions", group: "survival", label: "extinctions", fmt: f0, diff: s0 },
  { key: "rogueBlocked", group: "safety", label: "rogue payments blocked", fmt: f0, diff: s0 },
  { key: "rogueLeaked", group: "safety", label: "credits leaked by the rogue", fmt: f0, diff: s0 },
  { key: "supplyDrift", group: "safety", label: "max supply drift (micro-credits)", fmt: f0, diff: s0 },
];

/** Two-sided sign-flip p-value: exhaustive through 16 pairs, then fixed-seed Monte Carlo. */
export function signFlipP(d: number[]) {
  const n = d.length;
  const obs = Math.abs(d.reduce((a, b) => a + b, 0));
  if (obs < 1e-12) return 1;
  let hit = 0;
  if (n <= 16) {
    const total = 1 << n;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += mask & (1 << i) ? -d[i] : d[i];
      if (Math.abs(s) >= obs - 1e-9) hit++;
    }
    return hit / (1 << n);
  }

  const samples = 100_000;
  const r = rng(7 + n);
  for (let k = 0; k < samples; k++) {
    let s = 0;
    for (const x of d) s += r() < 0.5 ? -x : x;
    if (Math.abs(s) >= obs - 1e-9) hit++;
  }
  // The +1 correction avoids reporting p=0 from a finite Monte Carlo sample.
  return (hit + 1) / (samples + 1);
}

/** Percentile bootstrap 95% CI of the mean, with a fixed RNG so the file reproduces byte for byte. */
export function bootstrapCI(d: number[], b = 10_000, seed = 7): [number, number] {
  const r = rng(seed);
  const means: number[] = [];
  for (let k = 0; k < b; k++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(r() * d.length)];
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(0.025 * b)], means[Math.ceil(0.975 * b) - 1]];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function compare(base: WindRun[], other: WindRun[], key: Key) {
  const d = base.map((r, i) => other[i][key] - r[key]);
  return { diff: mean(d), ci: bootstrapCI(d), p: signFlipP(d) };
}

function seedList(spec: string | undefined) {
  const m = (spec ?? "1..30").match(/^(\d+)\.\.(\d+)$/);
  if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
  return spec!.split(",").map(Number);
}

const r4 = (x: number) => +x.toFixed(4);

export async function windtunnel(seeds: number[], ticks: number, sets = RULE_SETS) {
  const runs: Record<string, WindRun[]> = {};
  for (const s of sets) {
    runs[s.id] = [];
    for (const seed of seeds) runs[s.id].push(await runRules(seed, s.rules, ticks));
    console.error(`${s.id}: done`);
  }
  const base = runs[sets[0].id];
  const summary = Object.fromEntries(
    sets.map((s) => [s.id, Object.fromEntries(WIND_METRICS.map((m) => {
      const xs = runs[s.id].map((r) => r[m.key]);
      return [m.key, { mean: r4(mean(xs)), min: r4(Math.min(...xs)), max: r4(Math.max(...xs)) }];
    }))]),
  );
  const vsBaseline = Object.fromEntries(
    sets.slice(1).map((s) => [s.id, Object.fromEntries(WIND_METRICS.map((m) => {
      const c = compare(base, runs[s.id], m.key);
      return [m.key, { diff: r4(c.diff), ci: c.ci.map(r4), p: +c.p.toFixed(6) }];
    }))]),
  );
  return { ticks, seeds, ruleSets: sets, metrics: WIND_METRICS.map(({ key, group, label }) => ({ key, group, label })), summary, vsBaseline, runs };
}

export function report(w: Awaited<ReturnType<typeof windtunnel>>) {
  const sets = w.ruleSets;
  const star = (p: number) => (p < 0.01 ? " **" : p < 0.05 ? " *" : "");
  const pText = (p: number) => p < 0.001 ? "<0.001" : `=${p.toFixed(3)}`;
  const lines = [
    "# Wind tunnel: market rules against an evolving population",
    "",
    `Seeds ${w.seeds.join(", ")}; ${w.ticks} ticks; Gaussian mutation, no LLM. Generated by \`make windtunnel\`. Each rule set changes one knob from the baseline; every set runs on the same seeds, so comparisons are paired by seed.`,
    "",
    "| rule set | rules changed | question |",
    "|---|---|---|",
    ...sets.map((s) => `| ${s.label} | ${Object.keys(s.rules).length ? Object.entries(s.rules).map(([k, v]) => `\`${k}: ${v}\``).join(", ") : "defaults"} | ${s.question} |`),
    "",
    "## Outcomes",
    "",
    "Each cell: mean over seeds (min to max). \"At the end\" means tick " + w.ticks + "; rates are averaged over the whole run in 50-tick windows.",
    "",
    `| metric | ${sets.map((s) => s.label).join(" | ")} |`,
    `|---|${sets.map(() => "---").join("|")}|`,
    ...WIND_METRICS.map((m) => `| ${m.label} | ${sets.map((s) => { const x = w.summary[s.id][m.key]; return `${m.fmt(x.mean)} (${m.fmt(x.min)} to ${m.fmt(x.max)})`; }).join(" | ")} |`),
    "",
    "## Difference from the baseline",
    "",
    `Each cell: mean paired difference (rule set minus baseline, same seed), [95% bootstrap CI], and a two-sided sign-flip p-value. It is exact through 16 paired seeds; above 16 it uses 100,000 fixed-seed Monte Carlo sign assignments with the +1 correction (minimum reportable p=0.00001). * p < 0.05, ** p < 0.01. With ${(sets.length - 1) * WIND_METRICS.length} comparisons, two or three would reach p < 0.05 by chance alone, so read single-star results as tentative.`,
    "",
    `| metric | ${sets.slice(1).map((s) => s.label).join(" | ")} |`,
    `|---|${sets.slice(1).map(() => "---").join("|")}|`,
    ...WIND_METRICS.map((m) => `| ${m.label} | ${sets.slice(1).map((s) => { const c = w.vsBaseline[s.id][m.key]; return `${m.diff(c.diff)} [${m.diff(c.ci[0])}, ${m.diff(c.ci[1])}] p${pText(c.p)}${star(c.p)}`; }).join(" | ")} |`),
    "",
    "## Differences at p < 0.01",
    "",
    ...sets.slice(1).map((s) => {
      const hits = WIND_METRICS.filter((m) => w.vsBaseline[s.id][m.key].p < 0.01).map((m) => `${m.label} ${m.diff(w.vsBaseline[s.id][m.key].diff)}`);
      const identical = w.runs[s.id].every((r, i) => WIND_METRICS.every((m) => r[m.key] === w.runs[sets[0].id][i][m.key]));
      if (identical) return `- **${s.label}**: none. Every seed is identical to the baseline: this knob never bound.`;
      return `- **${s.label}**: ${hits.length ? hits.join("; ") : "none"}.`;
    }),
    "",
    `Total supply was conserved at every tick of all ${sets.length * w.seeds.length} runs (max drift ${Math.max(...sets.map((s) => w.summary[s.id].supplyDrift.max))} micro-credits; the economy also throws if it ever drifts).`,
    "",
    "Per seed:",
    "",
    `| rule set | seed | ${WIND_METRICS.map((m) => m.key).join(" | ")} |`,
    `|---|---:|${WIND_METRICS.map(() => "---:").join("|")}|`,
    ...sets.flatMap((s) => w.runs[s.id].map((r) => `| ${s.id} | ${r.seed} | ${WIND_METRICS.map((m) => m.fmt(r[m.key])).join(" | ")} |`)),
    "",
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const w = await windtunnel(seedList(process.env.SEEDS), Number(process.env.TICKS ?? 2000));
  const md = report(w);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "windtunnel.json"), JSON.stringify(w, null, 1) + "\n");
  fs.writeFileSync(path.join(RESULTS, "windtunnel.md"), md);
  console.log(md);
  console.error(`${Object.keys(w.runs).length} rule sets x ${w.seeds.length} seeds in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
