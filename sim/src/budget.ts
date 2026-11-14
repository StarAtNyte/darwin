// Hard dollar budget for every Claude call DARWIN makes (solver and mutation operator).
// Same accounting as SIEGE's `budget` (vendor/siege/src/llm/judge.ts), but the env is read at call time and
// the defaults are DARWIN's own spend file and a $2.50 cap, so DARWIN never draws from SIEGE's pot by accident.
//   NEAR_LLM_BUDGET_FILE (default ~/.darwin-llm-spend.json)
//   NEAR_LLM_BUDGET_USD  (default 2.5)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MODEL = "claude-haiku-5-5";
const PRICE_IN = 0.1 / 1e6; // $/token, claude-haiku-5-5
const PRICE_OUT = 0.5 / 1e6;

export class BudgetExceeded extends Error {}

const file = () => process.env.NEAR_LLM_BUDGET_FILE ?? path.join(os.homedir(), ".darwin-llm-spend.json");
const cap = () => Number(process.env.NEAR_LLM_BUDGET_USD ?? 2.5);

const read = (): { usd?: number; day?: string; dayUsd?: number } => {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
};
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export const budget = {
  spent(): number {
    return read().usd ?? 0;
  },
  /** Spend recorded so far on this UTC day (the file also keeps the day's total, for daily caps such as live AI). */
  spentToday(now = Date.now()): number {
    const j = read();
    return j.day === today(now) ? (j.dayUsd ?? 0) : 0;
  },
  add(usd: number, now = Date.now()) {
    const j = read();
    const day = today(now);
    const next = (j.usd ?? 0) + usd;
    const dayUsd = (j.day === day ? (j.dayUsd ?? 0) : 0) + usd;
    fs.writeFileSync(file(), JSON.stringify({ usd: next, updated: new Date(now).toISOString(), day, dayUsd }));
    return next;
  },
  /** Throws once the spend file reaches the cap. `reserve` refuses a call that could cross it. */
  check(reserve = 0.002) {
    if (this.spent() + reserve >= cap()) throw new BudgetExceeded(`LLM budget $${cap()} exhausted`);
  },
  record(usage: { input_tokens: number; output_tokens: number }) {
    return this.add(usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT);
  },
};
