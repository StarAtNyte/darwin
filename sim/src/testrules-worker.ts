// Worker thread for "Test your rules" (testrules.ts): runs wind tunnel runs off the main thread, at the lowest CPU
// priority, so the shared live run keeps ticking on time while a visitor's test computes.
import os from "node:os";
import { parentPort } from "node:worker_threads";
import { runRules } from "./windtunnel.ts";
import { trim } from "./testrules.ts";
import type { Config } from "./economy.ts";

try {
  os.setPriority(19); // on Linux this lowers this thread only, not the live run's
} catch {}

parentPort!.on("message", async (m: { tasks: { seed: number; rules: Partial<Config> }[]; rounds: number }) => {
  try {
    const runs = [];
    for (const t of m.tasks) {
      const t0 = performance.now();
      const r = trim(await runRules(t.seed, t.rules, m.rounds));
      runs.push({ ...r, ms: Math.round(performance.now() - t0) });
      parentPort!.postMessage({ type: "progress", done: runs.length });
    }
    parentPort!.postMessage({ type: "done", runs });
  } catch (e) {
    parentPort!.postMessage({ type: "error", message: (e as Error).message });
  }
});
