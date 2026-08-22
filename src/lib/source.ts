import type { Store } from "./store.js";
import { META_KEYS, type SourceType } from "../types.js";

export async function setSource(store: Store, url: string): Promise<SourceType> {
  const sourceUrl = url.trim();
  const type = await detectSource(sourceUrl);
  const previous = await store.getMeta(META_KEYS.SOURCE_URL);
  if (previous && previous !== sourceUrl) {
    await store.resetPages();
    await store.setMeta(META_KEYS.NEEDS_REBUILD, "1");
    await store.clearMeta(META_KEYS.SCRAPER_COLLECTOR_ID);
    console.log(`Switched source from "${previous}", wiped the stored pages.`);
  }
  await store.setMeta(META_KEYS.SOURCE_URL, sourceUrl);
  await store.setMeta(META_KEYS.SOURCE_TYPE, type);
  await store.setMeta(META_KEYS.CREATED_AT, new Date().toISOString());
  return type;
}

export function classifySourceUrl(url: string): SourceType {
  if (url.includes("/llms.txt")) return "llms-txt";
  if (url.endsWith(".xml") || /sitemap/i.test(url)) return "sitemap";
  return "html";
}

export async function detectSource(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<SourceType> {
  if (url.includes("/llms.txt")) return "llms-txt";
  if (url.endsWith(".xml") || /sitemap/i.test(url)) return "sitemap";

  const base = url.replace(/\/+$/, "");
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "";
  }
  const probes: Array<[string, SourceType]> = [
    [`${base}/llms.txt`, "llms-txt"],
    [`${base}/sitemap.xml`, "sitemap"],
  ];
  if (origin && origin !== base) {
    probes.push(
      [`${origin}/llms.txt`, "llms-txt"],
      [`${origin}/llms-full.txt`, "llms-txt"],
      [`${origin}/sitemap.xml`, "sitemap"]
    );
  }

  for (const [probeUrl, type] of probes) {
    try {
      const res = await fetchImpl(probeUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return type;
    } catch {
      // network error, try the next probe
    }
  }
  return "html";
}
