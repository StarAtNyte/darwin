// Tier-2 solver: Claude (cheapest tier) for the hardest reasoning tasks, under the shared hard budget.
// Off unless ANTHROPIC_API_KEY is set and DARWIN_LLM=1; the scripted solver is used otherwise.
import Anthropic from "@anthropic-ai/sdk";
import { budget, JUDGE_MODEL } from "siege";
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
      model: JUDGE_MODEL,
      max_tokens: 64,
      output_config: { effort: "low" },
      system: "Answer with only the final answer, no words.",
      messages: [{ role: "user", content: t.prompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    budget.record(res.usage);
    const b = res.content.find((x) => x.type === "text");
    return b && b.type === "text" ? b.text.trim() : undefined;
  } catch {
    return undefined;
  }
}
