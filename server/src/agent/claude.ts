import Anthropic from "@anthropic-ai/sdk";
import { LLM_MODEL } from "../config.js";

let client: Anthropic | null = null;
export const getClient = () => (client ??= new Anthropic());

/**
 * One-shot structured extraction: Claude answers by calling `tool`, and the tool input is the result.
 * (Forced tool_choice is not available on this model, so the prompt asks for the call explicitly.)
 */
export async function extractWithTool<T>(
  system: string,
  content: string | Anthropic.Beta.BetaContentBlockParam[],
  tool: Anthropic.Beta.BetaTool,
  effort: "low" | "medium" = "low",
): Promise<T> {
  const res = await getClient().beta.messages.create({
    model: LLM_MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort },
    system,
    tools: [tool],
    messages: [{ role: "user", content }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  if (res.stop_reason === "refusal") throw new Error("Claude declined the request");
  const use = res.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === tool.name);
  if (!use) throw new Error("Claude did not return structured output");
  return use.input as T;
}
