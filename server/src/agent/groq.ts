import { GROQ_API_KEY, LLM_MODEL } from "../config.js";

/** Minimal Groq client (OpenAI-compatible chat completions with tool calling). */

const BASE = "https://api.groq.com/openai/v1";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export async function chat(body: { model?: string; messages: ChatMessage[]; tools?: ToolDef[]; tool_choice?: unknown; response_format?: unknown; temperature?: number }) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: LLM_MODEL, temperature: 0.2, ...body }),
  });
  const j = (await r.json()) as { choices?: Array<{ message: ChatMessage; finish_reason: string }>; error?: { message?: string } };
  if (!r.ok || !j.choices?.length) throw new Error(`Groq ${r.status}: ${j.error?.message ?? "no response"}`);
  return j.choices[0];
}

/** Structured extraction: forces one tool call and returns its parsed arguments. */
export async function extractWithTool<T>(system: string, user: string | ContentPart[], tool: ToolDef["function"], model?: string): Promise<T> {
  const res = await chat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools: [{ type: "function", function: tool }],
    tool_choice: { type: "function", function: { name: tool.name } },
  });
  const call = res.message.tool_calls?.find((c) => c.function.name === tool.name);
  if (!call) throw new Error("The model did not return structured output");
  return JSON.parse(call.function.arguments) as T;
}
