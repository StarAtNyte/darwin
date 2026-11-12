// Tier-2 solver: Claude (cheapest tier) for the hardest reasoning tasks, under DARWIN's hard budget (budget.ts).
// Off unless ANTHROPIC_API_KEY is set and DARWIN_LLM=1; the scripted solver is used otherwise.
import Anthropic from "@anthropic-ai/sdk";
import { budget, MODEL } from "./budget.ts";
import type { Task } from "./tasks.ts";

const MAX_CALLS = Number(process.env.DARWIN_LLM_MAX_CALLS ?? 60);
let calls = 0;
let client: Anthropic | undefined;

export const llmSolverEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY) && process.env.DARWIN_LLM === "1" && calls < MAX_CALLS;

export async function llmSolve(t: Task): Promise<string | undefined> {
  try {
    budget.check();
    calls++;
    client ??= new Anthropic();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 64,
      output_config: { effort: "low" },
      system: "Answer with only the final answer, no words.",
      messages: [{ role: "user", content: t.prompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    budget.record(res.usage);
    const b = res.content.find((x) => x.type === "text");
    return b && b.type === "text" ? finalAnswer(b.text) : undefined;
  } catch {
    return undefined;
  }
}

/** Models sometimes show working despite the instruction; the answer is the last number (unicode minus normalised). */
export function finalAnswer(text: string): string {
  const nums = text.replace(/\u2212/g, "-").match(/-?\d+(?:\.\d+)?/g);
  return nums ? nums[nums.length - 1] : text.trim();
}
