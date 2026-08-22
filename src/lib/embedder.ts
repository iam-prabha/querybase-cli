import type { Store } from "./store.js";
import { requireKey } from "./keys.js";
import { embeddingBreaker } from "./circuit-breaker.js";
import { withRetry } from "./retry.js";

export interface EmbedConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  inputType?: string;
  maxChunkTokens: number;
}

const BATCH_SIZE = 64;

export async function getEmbedConfig(store: Store): Promise<EmbedConfig> {
  return {
    apiKey: await requireKey(store, "embed", "embedding"),
    baseUrl: (process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
    inputType: process.env.EMBEDDING_INPUT_TYPE || undefined,
    maxChunkTokens: Number(process.env.EMBEDDING_MAX_CHUNK_TOKENS ?? 480),
  };
}

export async function embedTexts(
  config: EmbedConfig,
  texts: string[],
  inputType?: string
): Promise<number[][]> {
  const type = inputType ?? config.inputType;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedSafe(config, texts.slice(i, i + BATCH_SIZE), type)));
  }
  return out;
}

async function embedSafe(
  config: EmbedConfig,
  texts: string[],
  inputType?: string
): Promise<number[][]> {
  try {
    return await embedChunk(config, texts, inputType);
  } catch (err) {
    if (
      err instanceof Error &&
      /exceeds maximum allowed token size/i.test(err.message) &&
      texts.some((t) => t.length > 64)
    ) {
      const out: number[][] = [];
      for (const t of texts) {
        if (t.length > 64) out.push(...(await embedSafe(config, splitInHalf(t), inputType)));
        else out.push(...(await embedSafe(config, [t], inputType)));
      }
      return out;
    }
    throw err;
  }
}

function splitInHalf(text: string): string[] {
  const mid = Math.floor(text.length / 2);
  const space = text.slice(0, mid).lastIndexOf(" ");
  const cut = space >= mid * 0.5 ? space : mid;
  const left = text.slice(0, cut).trim();
  const right = text.slice(cut).trim();
  return [left, right].filter((s) => s.length > 0);
}

async function embedChunk(
  config: EmbedConfig,
  texts: string[],
  inputType?: string
): Promise<number[][]> {
  return embeddingBreaker.execute(() => withRetry(async () => {
    const body: Record<string, unknown> = { model: config.model, input: texts };
    if (inputType) body.input_type = inputType;
    const res = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embedding request failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }));
}
