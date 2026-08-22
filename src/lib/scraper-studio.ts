import type { Store } from "./store.js";
import { META_KEYS } from "../types.js";
import { scraperStudioBreaker } from "./circuit-breaker.js";
import { withRetry } from "./retry.js";
import { turndown } from "./turndown.js";

export const COLLECTOR_DESCRIPTION =
  'Extract the full text content of this documentation page in reading order. Return a single JSON object per page: {"title": string, "blocks": [{"type": "heading", "level": int, "text": string}] or [{"type": "paragraph", "text": string}] or [{"type": "code", "code": string}]}. Use heading levels 1 to 3 only, keep code blocks verbatim, include page content only, no navigation, menus, ads, or footer boilerplate.';

export class TransportError extends Error {}

export interface ScraperOptions {
  generationTimeoutMs?: number;
  datasetTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (done: number, total: number, note: string) => void;
}

const DEFAULT_GENERATION_TIMEOUT_MS = 900_000;
const DEFAULT_DATASET_TIMEOUT_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000, 4_000];
const API_BASE = "https://api.brightdata.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<any> {
  return scraperStudioBreaker.execute(() => withRetry(async () => {
    let status: number | undefined;
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Scraper Studio request failed (${res.status}): ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) : null;
    } catch (err) {
      const transient = status === undefined ? true : status === 429 || status >= 500;
      if (!transient) throw err;
      throw err;
    }
  }));
}

export async function createCollector(apiKey: string, name: string): Promise<string> {
  const body = await request(apiKey, "/dca/collector", {
    method: "POST",
    body: {
      name,
      deliver: {
        type: "webhook",
        endpoint: "https://example.com/webhook",
        filename: { template: "data", extension: "json" },
      },
    },
  });
  if (!body || typeof body.id !== "string") {
    throw new Error("Scraper Studio did not return a collector id");
  }
  return body.id;
}

export async function triggerGeneration(apiKey: string, collectorId: string, urls: string[]): Promise<void> {
  await request(apiKey, `/dca/collectors/${collectorId}/automate_template`, {
    method: "POST",
    body: { description: COLLECTOR_DESCRIPTION, urls },
  });
}

async function generationStatus(apiKey: string, collectorId: string): Promise<string> {
  try {
    const body = await request(apiKey, `/dca/collectors/${collectorId}/automate_template/progress`);
    return typeof body?.status === "string" ? body.status : "no-job";
  } catch {
    return "no-job";
  }
}

async function pollGeneration(
  apiKey: string,
  collectorId: string,
  opts: ScraperOptions
): Promise<void> {
  const timeout = opts.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const totalPolls = Math.max(1, Math.ceil(timeout / interval));
  const deadline = Date.now() + timeout;
  for (let poll = 1; ; poll++) {
    const status = await generationStatus(apiKey, collectorId);
    if (status === "done") return;
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Scraper Studio collector generation failed (${collectorId})`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for collector generation (${collectorId})`);
    }
    opts.onProgress?.(0, 0, `generating collector, polled ${poll} of ${totalPolls}`);
    await sleep(interval);
  }
}

export async function ensureCollector(
  apiKey: string,
  store: Store,
  sourceUrl: string,
  urls: string[],
  opts: ScraperOptions
): Promise<string> {
  const existing = await store.getMeta(META_KEYS.SCRAPER_COLLECTOR_ID);
  if (existing) {
    const status = await generationStatus(apiKey, existing);
    if (status === "failed" || status === "no-job") {
      await triggerGeneration(apiKey, existing, sampleUrls(urls, sourceUrl));
    }
    await pollGeneration(apiKey, existing, opts);
    return existing;
  }
  const name =
    sourceUrl
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "docs";
  const id = await createCollector(apiKey, name);
  await store.setMeta(META_KEYS.SCRAPER_COLLECTOR_ID, id);
  await triggerGeneration(apiKey, id, sampleUrls(urls, sourceUrl));
  await pollGeneration(apiKey, id, opts);
  return id;
}

function sampleUrls(urls: string[], sourceUrl: string): string[] {
  let origin = "";
  try {
    origin = new URL(sourceUrl).origin;
  } catch {
    return urls.slice(0, 1);
  }
  const sameOrigin = urls.filter((u) => {
    try {
      return new URL(u).origin === origin;
    } catch {
      return false;
    }
  });
  const pool = sameOrigin.length > 0 ? sameOrigin : urls;
  return pool.slice(0, 1);
}

async function pollDataset(
  apiKey: string,
  collectionId: string,
  opts: ScraperOptions
): Promise<unknown[]> {
  const timeout = opts.datasetTimeoutMs ?? DEFAULT_DATASET_TIMEOUT_MS;
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    const body = await request(apiKey, `/dca/dataset?id=${collectionId}`);
    if (Array.isArray(body)) return body;
    if (Date.now() > deadline) {
      throw new TransportError(`Timed out waiting for the Scraper Studio dataset (${collectionId})`);
    }
    await sleep(interval);
  }
}

export function mapRowsToMarkdown(
  rows: unknown[],
  submittedUrls: string[],
  minLength: number
): { markdowns: Map<string, string>; failed: string[] } {
  const markdowns = new Map<string, string>();
  const failed: string[] = [];
  for (const url of submittedUrls) {
    const row = rows.find((r) => rowUrl(r) === url);
    const markdown = row ? serializeExtraction(rowExtraction(row)) : "";
    if (markdown && markdown.trim().length >= minLength) {
      markdowns.set(url, markdown);
    } else {
      failed.push(url);
    }
  }
  return { markdowns, failed };
}

export async function runBatch(
  apiKey: string,
  collectorId: string,
  urls: string[],
  opts: ScraperOptions,
  minLength: number
): Promise<{ markdowns: Map<string, string>; failed: string[] }> {
  try {
    const body = await request(apiKey, `/dca/trigger?collector=${collectorId}`, {
      method: "POST",
      body: urls.map((url) => ({ url })),
    });
    if (!body || typeof body.collection_id !== "string") {
      throw new Error("Scraper Studio batch did not return a collection id");
    }
    const rows = await pollDataset(apiKey, body.collection_id, opts);
    return mapRowsToMarkdown(rows, urls, minLength);
  } catch (err) {
    if (err instanceof TransportError) throw err;
    throw new TransportError(err instanceof Error ? err.message : String(err));
  }
}

export async function healCollector(
  apiKey: string,
  collectorId: string,
  prompt: string,
  opts: ScraperOptions
): Promise<void> {
  await request(apiKey, `/dca/collectors/${collectorId}/refactor_template`, {
    method: "POST",
    body: { prompt, custom_input: [] },
  });
  const timeout = opts.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    const body = await request(apiKey, `/dca/collectors/${collectorId}/refactor_template/progress`);
    const status = typeof body?.status === "string" ? body.status : "running";
    if (status === "done") return;
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Scraper Studio heal failed (${collectorId})`);
    }
    if (status === "pending_answer" || status === "awaiting_approval") {
      await request(apiKey, `/dca/collectors/${collectorId}/resume_automation_job`, {
        method: "POST",
        body: { message: true },
      });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for the Scraper Studio heal (${collectorId})`);
    }
    opts.onProgress?.(0, 0, `healing collector, ${collectorId}`);
    await sleep(interval);
  }
}

function rowUrl(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.url === "string") return r.url;
  const input = r.input as Record<string, unknown> | undefined;
  if (input && typeof input.url === "string") return input.url;
  return null;
}

function rowExtraction(row: unknown): unknown {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (r.error !== undefined) return null;
  if (r.extraction !== undefined && r.extraction !== null) return r.extraction;
  if (typeof r.raw_content === "string" && r.raw_content.trim().length > 0) return r.raw_content;
  if (typeof r.raw === "string" && r.raw.trim().length > 0) return r.raw;
  if (r.title !== undefined || r.blocks !== undefined) return r;
  if (typeof r.text === "string") return r.text;
  return null;
}

function serializeExtraction(extraction: unknown): string {
  if (typeof extraction === "string") {
    return /<html[\s>]|<body[\s>]|<!DOCTYPE/i.test(extraction)
      ? turndown.turndown(extraction)
      : extraction;
  }
  if (typeof extraction !== "object" || extraction === null) return "";
  const e = extraction as Record<string, unknown>;
  const title = typeof e.title === "string" ? e.title.trim() : "";
  const blocks = Array.isArray(e.blocks) ? e.blocks : [];
  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "heading" && typeof b.text === "string") {
      const level = Number.isInteger(b.level) ? Math.max(1, Math.min(3, b.level as number)) : 1;
      parts.push(`${"#".repeat(level)} ${b.text}`);
    } else if (b.type === "code" && typeof b.code === "string") {
      parts.push(`\`\`\`\n${b.code}\n\`\`\``);
    } else if (b.type === "paragraph" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n\n");
}
