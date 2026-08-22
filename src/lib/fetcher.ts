import { bdclient } from "@brightdata/sdk";
import { storeFromEnv } from "./store.js";
import {
  ensureCollector,
  healCollector,
  runBatch,
  TransportError,
  type ScraperOptions,
} from "./scraper-studio.js";
import { META_KEYS } from "../types.js";
import { brightDataBreaker } from "./circuit-breaker.js";
import { withRetry } from "./retry.js";
import { toMarkdown } from "./turndown.js";

const BATCH_SIZE = 5;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SCRAPER_MIN_USABLE_TEXT_LENGTH = envInt("SCRAPER_MIN_USABLE_TEXT_LENGTH", 200);
const SCRAPER_HEAL_MIN_FAILURES = envInt("SCRAPER_HEAL_MIN_FAILURES", 2);
const SCRAPER_MAX_HEALS = envInt("SCRAPER_MAX_HEALS", 1);

export function shouldHeal(
  failedCount: number,
  minFailures: number,
  heals: number,
  maxHeals: number,
  transportFailed: boolean
): boolean {
  return !transportFailed && failedCount >= minFailures && heals < maxHeals;
}

function isUsable(item: unknown): item is string {
  if (typeof item !== "string") return false;
  const trimmed = item.trim();
  return trimmed.length > 0 && trimmed !== "null" && trimmed !== "undefined";
}

async function sdkFetchPages(
  apiKey: string,
  urls: string[],
  onProgress?: (done: number, total: number, note: string) => void
): Promise<Map<string, string>> {
  return brightDataBreaker.execute(() => withRetry(async () => {
    const client = new bdclient({ apiKey });
    const result = new Map<string, string>();
    try {
      for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        const chunk = urls.slice(i, i + BATCH_SIZE);
        const data = await client.scrapeUrl(chunk);
        for (let j = 0; j < chunk.length; j++) {
          const item = data[j];
          if (isUsable(item)) {
            result.set(chunk[j], toMarkdown(item));
          }
        }
        onProgress?.(Math.min(i + chunk.length, urls.length), urls.length, "");
      }
    } finally {
      await client.close();
    }
    return result;
  }));
}

export async function fetchPagesAsMarkdown(
  apiKey: string,
  urls: string[],
  onProgress?: (done: number, total: number, note: string) => void
): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map<string, string>();
  const store = storeFromEnv();
  const opts: ScraperOptions = {
    generationTimeoutMs: envInt("SCRAPER_GENERATION_TIMEOUT", 900) * 1000,
    datasetTimeoutMs: envInt("SCRAPER_DATASET_TIMEOUT", 3600) * 1000,
    pollIntervalMs: envInt("SCRAPER_POLL_INTERVAL", 10) * 1000,
    onProgress,
  };
  try {
    await store.init();
    const sourceUrl = (await store.getMeta(META_KEYS.SOURCE_URL)) ?? "source";
    const collectorId = await ensureCollector(apiKey, store, sourceUrl, urls, opts);
    const markdowns = new Map<string, string>();
    let failed: string[] = [];
    let transportFailed = false;
    try {
      const first = await runBatch(apiKey, collectorId, urls, opts, SCRAPER_MIN_USABLE_TEXT_LENGTH);
      for (const [url, markdown] of first.markdowns) markdowns.set(url, markdown);
      failed = first.failed;
    } catch (err) {
      if (err instanceof TransportError) {
        transportFailed = true;
        failed = urls;
        console.error(
          `warning: Scraper Studio fetch failed (${err.message}), falling back to the SDK`
        );
      } else {
        throw err;
      }
    }

    let heals = 0;
    while (
      shouldHeal(failed.length, SCRAPER_HEAL_MIN_FAILURES, heals, SCRAPER_MAX_HEALS, transportFailed)
    ) {
      const prompt = `Extraction comes back empty or too short for ${failed.length} pages, including ${failed[0]}. The page content exists; return the full text as title plus blocks.`;
      try {
        await healCollector(apiKey, collectorId, prompt, opts);
      } catch (err) {
        console.error(
          `warning: Scraper Studio heal failed (${collectorId}), ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        break;
      }
      heals++;
      try {
        const retry = await runBatch(apiKey, collectorId, failed, opts, SCRAPER_MIN_USABLE_TEXT_LENGTH);
        for (const [url, markdown] of retry.markdowns) markdowns.set(url, markdown);
        failed = retry.failed;
      } catch (err) {
        if (err instanceof TransportError) {
          console.error(
            `warning: Scraper Studio retry failed (${err.message}), falling back to the SDK`
          );
          break;
        }
        throw err;
      }
    }

    if (failed.length > 0) {
      const fallback = await sdkFetchPages(apiKey, failed, onProgress);
      for (const [url, markdown] of fallback) markdowns.set(url, markdown);
      const stillFailed = failed.filter((url) => !markdowns.has(url));
      if (stillFailed.length > 0) {
        console.error(`warning: ${stillFailed.length} page(s) failed to fetch, skipped`);
        for (const url of stillFailed) console.error(`  ${url}`);
      }
    }
    onProgress?.(urls.length, urls.length, "");
    return markdowns;
  } catch (err) {
    console.error(
      `warning: Scraper Studio unavailable (${err instanceof Error ? err.message : String(err)}), falling back to the SDK`
    );
    return sdkFetchPages(apiKey, urls, onProgress);
  } finally {
    await store.close();
  }
}
