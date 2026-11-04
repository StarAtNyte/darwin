// Synthetic tasks with known answers, and a referee that scores them deterministically.
// Not a general oracle: the referee knows the answer because the generator wrote it.

export type Kind = "arith" | "extract" | "classify" | "reason";
export const KINDS: Kind[] = ["arith", "extract", "classify", "reason"];

export interface Task {
  id: number;
  kind: Kind;
  difficulty: 1 | 2 | 3;
  prompt: string;
  answer: string;
  reward: number; // micro credits
  postedTick: number;
}

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = ReturnType<typeof rng>;
const ri = (r: Rng, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const pick = <T,>(r: Rng, xs: T[]) => xs[Math.floor(r() * xs.length)];

const NAMES = ["ada", "bo", "cyd", "dee", "eli", "fay", "gus", "hal", "ivy", "jo"];
const POS = ["great", "excellent", "love", "fast", "reliable", "superb", "happy"];
const NEG = ["broken", "slow", "awful", "refund", "terrible", "late", "angry"];

export function makeTask(r: Rng, id: number, tick: number, kindBias?: Kind): Task {
  const kind = kindBias ?? pick(r, KINDS);
  const difficulty = ri(r, 1, 3) as 1 | 2 | 3;
  let prompt = "", answer = "";
  switch (kind) {
    case "arith": {
      const n = difficulty + 1;
      const xs = Array.from({ length: n }, () => ri(r, 2, 10 ** difficulty * 3));
      const ops = Array.from({ length: n - 1 }, () => pick(r, ["+", "-", "*"]));
      let expr = String(xs[0]);
      ops.forEach((o, i) => (expr += ` ${o} ${xs[i + 1]}`));
      prompt = `Compute: ${expr}`;
      answer = String(Function(`"use strict";return (${expr})`)());
      break;
    }
    case "extract": {
      const who = pick(r, NAMES), dom = pick(r, ["acme.io", "mail.near", "corp.org"]);
      const filler = Array.from({ length: difficulty * 3 }, () => pick(r, ["meeting", "notes", "for", "the", "q4", "plan", "call", "at", "noon"])).join(" ");
      const decoy = difficulty >= 2 ? ` cc: no-reply@${dom}` : "";
      prompt = `Extract the sender email: ${filler} From: ${who}@${dom}${decoy} ${filler}`;
      answer = `${who}@${dom}`;
      break;
    }
    case "classify": {
      const pos = r() < 0.5;
      const main = Array.from({ length: difficulty + 1 }, () => pick(r, pos ? POS : NEG));
      const noise = difficulty >= 3 ? [pick(r, pos ? NEG : POS)] : [];
      prompt = `Sentiment (positive/negative): "${[...main, ...noise].sort(() => r() - 0.5).join(", ")}"`;
      answer = pos ? "positive" : "negative";
      break;
    }
    case "reason": {
      const a = ri(r, 1, 9), d = ri(r, 2, 4 + difficulty * 2), k = ri(r, 3, 4 + difficulty);
      const seq = Array.from({ length: k }, (_, i) => (difficulty === 3 ? a * d ** i : a + d * i));
      prompt = `Next number in the sequence: ${seq.join(", ")}, ?`;
      answer = String(difficulty === 3 ? a * d ** k : a + d * k);
      break;
    }
  }
  const reward = Math.round((40_000 + 40_000 * difficulty ** 1.5) * (0.8 + 0.4 * r()));
  return { id, kind, difficulty, prompt, answer, reward, postedTick: tick };
}

export function referee(t: Task, submitted: string | undefined): boolean {
  return submitted !== undefined && submitted.trim().toLowerCase() === t.answer.toLowerCase();
}

/** A competent scripted solver (stands in for the LLM tier when there is no API key). */
export function scriptedSolve(t: Task): string {
  const p = t.prompt;
  switch (t.kind) {
    case "arith":
      return String(Function(`"use strict";return (${p.replace("Compute: ", "")})`)());
    case "extract": {
      const m = p.match(/From: (\S+@\S+)/);
      return m ? m[1] : "";
    }
    case "classify": {
      const pos = POS.filter((w) => p.includes(w)).length, neg = NEG.filter((w) => p.includes(w)).length;
      return pos >= neg ? "positive" : "negative";
    }
    case "reason": {
      const xs = p.replace(/.*: /, "").replace(", ?", "").split(", ").map(Number);
      const d = xs[1] - xs[0];
      if (xs.every((x, i) => i === 0 || x - xs[i - 1] === d)) return String(xs[xs.length - 1] + d);
      const q = xs[1] / xs[0];
      return String(xs[xs.length - 1] * q);
    }
  }
}

/** A cheap heuristic worker: right with probability `p`, else a plausible wrong answer. */
export function sloppySolve(t: Task, p: number, r: Rng): string {
  if (r() < p) return scriptedSolve(t);
  return t.kind === "classify" ? (t.answer === "positive" ? "negative" : "positive") : `${t.answer}x`;
}
