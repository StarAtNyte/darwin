// Headless run for tuning: prints metrics every N ticks.
import { Economy } from "./economy.ts";
const ticks = Number(process.env.TICKS ?? 600);
const e = new Economy({ seed: Number(process.env.SEED ?? 42) });
const counts: Record<string, number> = {};
const e2 = e as any;
const orig = e2.emit;
const t0 = performance.now();
for (let i = 0; i < ticks; i++) {
  await e.step();
  if (e.tick % 50 === 0) {
    const m = e.lastMetrics;
    console.log(`t=${m.tick} pop=${m.population} deaths=${m.deaths} gen=${m.maxGeneration} dyn=${m.dynasties} gini=${m.gini.toFixed(2)} mid=${(m.middlemanShare * 100).toFixed(0)}% spec=${m.specialisation.toFixed(2)} markup=${m.meanMarkup.toFixed(2)} subc=${m.meanSubcontract.toFixed(2)} pool=${(m.pool / 1e6).toFixed(0)} rogue=${m.rogueBlocked}/${m.rogueAttempts} leaked=${m.rogueLeaked}`);
  }
}
console.log(`${ticks} ticks in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
