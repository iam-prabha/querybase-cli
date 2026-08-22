import type { Store } from "./store.js";
import { META_KEYS } from "../types.js";
import { fail } from "./keys.js";

export async function discoverPageUrls(store: Store): Promise<string[]> {
  const sourceUrl = await store.getMeta(META_KEYS.SOURCE_URL);
  const sourceType = await store.getMeta(META_KEYS.SOURCE_TYPE);
  if (!sourceUrl || !sourceType) fail("No source configured. Run `querybase init <url>` first.");
  if (sourceType === "llms-txt") return discoverFromLlmsTxt(sourceUrl);
  if (sourceType === "sitemap") return discoverFromSitemap(sourceUrl);
  fail(`Source type "${sourceType}" is not supported yet. Use a docs site with llms.txt or sitemap.xml.`);
}

async function discoverFromLlmsTxt(sourceUrl: string): Promise<string[]> {
  if (sourceUrl.includes("/llms.txt")) {
    const urls = await tryReadLlmsTxt(sourceUrl);
    if (urls) return urls;
    fail(`Could not read ${sourceUrl}.`);
  }
  const base = sourceUrl.replace(/\/+$/, "");
  let origin = "";
  try {
    origin = new URL(sourceUrl).origin;
  } catch {
    origin = "";
  }
  const candidates = new Set([`${base}/llms.txt`, `${base}/llms-full.txt`]);
  if (origin) {
    candidates.add(`${origin}/llms.txt`);
    candidates.add(`${origin}/llms-full.txt`);
  }
  for (const candidate of candidates) {
    const urls = await tryReadLlmsTxt(candidate);
    if (urls) return urls;
  }
  fail(`No llms.txt or llms-full.txt found at ${base}/.`);
}

async function tryReadLlmsTxt(url: string): Promise<string[] | null> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const text = await res.text();
  const origin = new URL(url).origin;
  const urls = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/\[[^\]]*\]\(([^)]+)\)/);
    const candidate = match ? match[1] : trimmed;
    if (!/^https?:\/\//.test(candidate)) continue;
    if (candidate.endsWith("/llms.txt") || candidate.endsWith("/llms-full.txt")) continue;
    try {
      urls.add(new URL(candidate, origin).href);
    } catch {
      // skip malformed urls
    }
  }
  return urls.size > 0 ? [...urls] : null;
}

async function discoverFromSitemap(sourceUrl: string): Promise<string[]> {
  const candidates: string[] = [];
  if (sourceUrl.includes("sitemap")) {
    candidates.push(sourceUrl);
  } else {
    const base = sourceUrl.replace(/\/+$/, "");
    candidates.push(`${base}/sitemap.xml`);
    let origin = "";
    try {
      origin = new URL(sourceUrl).origin;
    } catch {
      origin = "";
    }
    if (origin && origin !== base) candidates.push(`${origin}/sitemap.xml`);
  }

  let lastUrl = "";
  for (const sitemapUrl of candidates) {
    lastUrl = sitemapUrl;
    let res: Response;
    try {
      res = await fetch(sitemapUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const xml = await res.text();
    const urls = new Set<string>();
    for (const match of xml.matchAll(/<loc[^>]*>([^<]+)<\/loc>/gi)) {
      const raw = match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      try {
        urls.add(new URL(raw).href);
      } catch {
        // skip malformed urls
      }
    }
    if (urls.size > 0) return [...urls];
  }
  fail(`sitemap.xml not found at ${lastUrl}.`);
}
