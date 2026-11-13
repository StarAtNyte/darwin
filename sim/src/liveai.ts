// Live Claude in a shared run. Off by default; on with DARWIN_LIVE_AI=1 and ANTHROPIC_API_KEY.
//
// A public run replays Claude's recorded run (results/mutations/). With live AI on, every Nth fork
// (DARWIN_LIVE_AI_EVERY, default 10) skips the recording and asks claude-haiku-5-5 instead, and the dashboard labels
// that child "Claude decided · live". Hard limits, all checked before a call starts:
//   - at most one call per DARWIN_LIVE_AI_INTERVAL_SEC (default 60, never less than 60),
//   - at most DARWIN_LIVE_AI_DAILY_USD a UTC day (default and ceiling $0.30), read from budget.ts's spend file,
//   - budget.ts's overall cap (NEAR_LLM_BUDGET_USD) still applies.
// A fork that is not a live turn, or is refused by a limit, replays the recording (or falls back to Gaussian) as before.
// The first live child moves the run off the recording; later forks that are not live turns are then random.
import { budget } from "./budget.ts";
import { anthropicProvider, type MutationProvider } from "./mutator.ts";

export const LIVE_MIN_INTERVAL_MS = 60_000;
export const LIVE_DAILY_CAP_USD = 0.3;
/** Worst-case cost of one mutation call (about 2k tokens in, 1.5k out at haiku prices), reserved before it starts. */
export const LIVE_CALL_RESERVE_USD = 0.002;

export class LiveGate {
  forks = 0;
  calls = 0;
  private lastAt = -Infinity;
  constructor(
    readonly every = 10,
    readonly minIntervalMs = LIVE_MIN_INTERVAL_MS,
    readonly dailyCapUsd = LIVE_DAILY_CAP_USD,
    private now: () => number = () => Date.now(),
  ) {
    if (!(every >= 1)) throw new Error("every must be at least 1");
    this.minIntervalMs = Math.max(LIVE_MIN_INTERVAL_MS, minIntervalMs);
    this.dailyCapUsd = Math.min(LIVE_DAILY_CAP_USD, Math.max(0, dailyCapUsd));
  }

  /**
   * Count one fork. True when this fork is a live turn and every limit allows a call now; the call is then
   * reserved (the interval runs from here). False otherwise, with no side effect beyond the fork count.
   */
  take(): boolean {
    this.forks++;
    if (this.forks % this.every !== 0) return false;
    const t = this.now();
    if (t - this.lastAt < this.minIntervalMs) return false;
    if (budget.spentToday(t) + LIVE_CALL_RESERVE_USD > this.dailyCapUsd) return false;
    try {
      budget.check(LIVE_CALL_RESERVE_USD);
    } catch {
      return false;
    }
    this.lastAt = t;
    this.calls++;
    return true;
  }
}

/** The gate and Claude provider from the environment, or null when live AI is off. */
export function liveAiFromEnv(env: NodeJS.ProcessEnv = process.env, provider?: MutationProvider): { gate: LiveGate; provider: MutationProvider } | null {
  if (env.DARWIN_LIVE_AI !== "1" || !env.ANTHROPIC_API_KEY) return null;
  const gate = new LiveGate(
    Math.max(1, Math.floor(Number(env.DARWIN_LIVE_AI_EVERY ?? 10)) || 10),
    Number(env.DARWIN_LIVE_AI_INTERVAL_SEC ?? 60) * 1000,
    Number(env.DARWIN_LIVE_AI_DAILY_USD ?? LIVE_DAILY_CAP_USD),
  );
  return { gate, provider: provider ?? anthropicProvider() };
}
