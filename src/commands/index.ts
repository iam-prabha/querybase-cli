import type { Command } from "commander";
import { QdrantClient } from "@qdrant/js-client-rest";
import { storeFromEnv } from "../lib/store.js";
import { fail, loadEnv, requireKey, requireUser } from "../lib/keys.js";
import { getEmbedConfig, embedTexts } from "../lib/embedder.js";
import { sectionMarkdown } from "../lib/sectioner.js";
import { chunkText } from "../lib/chunk.js";
import {
  collectionName,
  ensureCollection,
  rebuildCollection,
  deletePagePoints,
  upsertSections,
} from "../lib/vector.js";
import { META_KEYS } from "../types.js";

async function acquireIndexLock(store: ReturnType<typeof storeFromEnv>, sourceUrl: string): Promise<boolean> {
  const lockKey = `index_lock_${Buffer.from(sourceUrl).toString("base64").slice(0, 32)}`;
  const result = await store.withTransaction(async (client: any) => {
    const res = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [lockKey]);
    return res.rows[0]?.acquired ?? false;
  });
  return result;
}

export function indexCommand(program: Command): Command {
  return program
    .command("index")
    .option("--rebuild", "delete and recreate the collection before indexing")
    .description("Section, embed, and store vectors for every pending page")
    .action(async (options: { rebuild?: boolean }) => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        await requireUser(store);
        const embed = await getEmbedConfig(store);
        const qdrantApiKey = await requireKey(store, "qdrant", "storing vectors");
        const qdrantUrl = process.env.QDRANT_URL;
        if (!qdrantUrl) fail("Missing QDRANT_URL in the environment. Add it to .env or export it.");
        const sourceUrl = await store.getMeta(META_KEYS.SOURCE_URL);
        if (!sourceUrl) fail("No source configured. Run `querybase crawl <url>` first.");

        const lockAcquired = await acquireIndexLock(store, sourceUrl);
        if (!lockAcquired) {
          fail("Another index operation is already running for this source. Wait for it to complete.");
        }

        const client = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });
        const name = collectionName(sourceUrl);
        const rebuild =
          options.rebuild || (await store.getMeta(META_KEYS.NEEDS_REBUILD)) === "1";
        if (rebuild) {
          await rebuildCollection(client, name, embed.dimensions);
          await store.setMeta(META_KEYS.NEEDS_REBUILD, "0");
          await store.resetIndexedState();
          console.log(`Recreated collection "${name}".`);
        } else {
          await ensureCollection(client, name, embed.dimensions);
        }

        const pending = await store.pendingIndexPages();
        console.log(`Indexing ${pending.length} page(s) into "${name}".`);
        let sectionCount = 0;
        for (let i = 0; i < pending.length; i++) {
          const page = pending[i];
          const sections = sectionMarkdown(page.markdown).flatMap((s) => {
            const textChunks = chunkText(s.text, embed.maxChunkTokens);
            return textChunks.map((text, chunkIndex) => ({
              pageUrl: page.url,
              headingPath: s.headingPath,
              text,
              chunkIndex,
            }));
          });
          if (sections.length === 0) {
            await store.markPageIndexed(page.url);
            continue;
          }
          const vectors = await embedTexts(embed, sections.map((s) => s.text), "passage");
          await deletePagePoints(client, name, page.url);
          await upsertSections(client, name, vectors, sections);
          await store.markPageIndexed(page.url);
          sectionCount += sections.length;
          console.log(`  [${i + 1}/${pending.length}] ${page.url} (${sections.length} sections)`);
        }
        console.log(`Indexed ${pending.length} page(s), ${sectionCount} section(s).`);
      } finally {
        await store.close();
      }
    });
}