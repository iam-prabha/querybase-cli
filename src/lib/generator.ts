import type { Store } from "./store.js";
import { requireKey } from "./keys.js";

export interface GenerationConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const NVIDIA_CHAT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";

export async function getGenerationConfig(store: Store): Promise<GenerationConfig> {
  const baseUrl = (
    process.env.GENERATION_BASE_URL ?? "https://integrate.api.nvidia.com/v1"
  ).replace(/\/+$/, "");
  const apiKey = await requireKey(store, "embed", "answering questions");
  const model = process.env.GENERATION_MODEL ?? NVIDIA_CHAT_MODEL;
  return { apiKey, baseUrl, model };
}

export async function generateAnswer(
  config: GenerationConfig,
  messages: ChatMessage[]
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`generation request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content?.trim() ?? "";
}
