// Headless run for tuning: prints metrics every 50 ticks.
//   TICKS=2000 SEED=7 MUTATION=llm npx tsx src/headless.ts
// MUTATION=llm|mixed replays results/mutations/seed-<seed>-<mode>.json and calls Claude only on cache misses
// (needs ANTHROPIC_API_KEY; DARWIN_MUTATION_MAX_CALLS caps live calls, default 400).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Economy } from "./economy.ts";
import { Mutator, type MutationMode } from "./mutator.ts";
const ticks = Number(process.env.TICKS ?? 600);
const seed = Number(process.env.SEED ?? 42);
const mode = (process.env.MUTATION ?? "gaussian") as MutationMode;
const here = path.dirname(fileURLToPath(import.meta.url));
const mut = mode === "gaussian" ? undefined : new Mutator({ cachePath: path.resolve(here, `../../results/mutations/seed-${seed}-${mode}.json`) });
const e = new Economy({ seed, mutation: mode }, () => {}, mut);
const t0 = performance.now();
for (let i = 0; i < ticks; i++) {
  await e.step();
  if (e.tick % 50 === 0) {
    const m = e.lastMetrics;
    console.log(`t=${m.tick} pop=${m.population} deaths=${m.deaths} gen=${m.maxGeneration} dyn=${m.dynasties} gini=${m.gini.toFixed(2)} mid=${(m.middlemanShare * 100).toFixed(0)}% spec=${m.specialisation.toFixed(2)} markup=${m.meanMarkup.toFixed(2)} subc=${m.meanSubcontract.toFixed(2)} pool=${(m.pool / 1e6).toFixed(0)} rogue=${m.rogueBlocked}/${m.rogueAttempts} leaked=${m.rogueLeaked}`);
  }
}
mut?.save({ seed, mode, ticks });
console.log(`${ticks} ticks in ${((performance.now() - t0) / 1000).toFixed(1)}s; forks by mutation source ${JSON.stringify(e.mutationStats)}`);
