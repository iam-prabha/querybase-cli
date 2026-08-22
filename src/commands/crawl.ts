import type { Command } from "commander";
import { createHash } from "node:crypto";
import { storeFromEnv } from "../lib/store.js";
import { loadEnv, requireKey, requireUser } from "../lib/keys.js";
import { discoverPageUrls } from "../lib/discovery.js";
import { fetchPagesAsMarkdown } from "../lib/fetcher.js";
import { pageTitle } from "../lib/sectioner.js";
import { setSource } from "../lib/source.js";

function contentHash(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function crawlCommand(program: Command): Command {
  return program
    .command("crawl <url>")
    .description("Set the source and fetch every page as markdown")
    .action(async (url: string) => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        await requireUser(store);
        const type = await setSource(store, url);
        console.log(`Source set to ${url.trim()} (${type}).`);
        const apiKey = await requireKey(store, "brightdata", "fetching pages");
        const urls = await discoverPageUrls(store);
        console.log(`Discovered ${urls.length} pages.`);
        const markdowns = await fetchPagesAsMarkdown(apiKey, urls, (done, total, note) => {
          console.log(note ? `  ${note}` : `  fetched ${done}/${total}`);
        });
        let saved = 0;
        let unchanged = 0;
        await store.withTransaction(async (client) => {
          for (const url of urls) {
            const markdown = markdowns.get(url);
            if (!markdown) continue;
            const hash = contentHash(markdown);
            const existing = await store.getPage(url);
            if (existing && existing.contentHash === hash) {
              unchanged++;
              continue;
            }
            await client.query(
              `INSERT INTO pages (url, title, markdown, content_hash, last_indexed_hash, fetched_at)
               VALUES ($1, $2, $3, $4, NULL, $5)
               ON CONFLICT (url) DO UPDATE SET
                 title = EXCLUDED.title,
                 markdown = EXCLUDED.markdown,
                 content_hash = EXCLUDED.content_hash,
                 last_indexed_hash = NULL,
                 fetched_at = EXCLUDED.fetched_at`,
              [url, pageTitle(markdown) ?? url, markdown, hash, new Date().toISOString()]
            );
            saved++;
          }
        });
        const total = await store.pageCount();
        console.log(
          `Saved ${saved} page(s), skipped ${unchanged} unchanged, ${total} page(s) in store.`
        );
      } finally {
        await store.close();
      }
    });
}