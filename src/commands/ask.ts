import type { Command } from "commander";
import { QdrantClient } from "@qdrant/js-client-rest";
import { storeFromEnv } from "../lib/store.js";
import { fail, loadEnv, requireKey, requireUser } from "../lib/keys.js";
import { getEmbedConfig, embedTexts } from "../lib/embedder.js";
import { getGenerationConfig, generateAnswer } from "../lib/generator.js";
import { collectionName, searchSections } from "../lib/vector.js";
import { META_KEYS } from "../types.js";

interface NumberedHit<T> {
  index: number;
  hit: T;
}

function numberHits<T>(hits: T[]): NumberedHit<T>[] {
  return hits.map((hit, i) => ({ index: i + 1, hit }));
}

export function askCommand(program: Command): Command {
  return program
    .command("ask <question>")
    .description("Ask a question and get an answer with sources")
    .option("--json", "emit machine readable JSON instead of console text")
    .action(async (question: string, options: { json?: boolean }) => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        await requireUser(store);
        const embed = await getEmbedConfig(store);
        const generation = await getGenerationConfig(store);
        const qdrantApiKey = await requireKey(store, "qdrant", "searching vectors");
        const qdrantUrl = process.env.QDRANT_URL;
        if (!qdrantUrl) fail("Missing QDRANT_URL in the environment. Add it to .env or export it.");
        const sourceUrl = await store.getMeta(META_KEYS.SOURCE_URL);
        if (!sourceUrl) fail("No source configured. Run `querybase init <url>` first.");

        const client = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });
        const name = collectionName(sourceUrl);
        const topK = Number(process.env.ASK_TOP_K ?? 5);

        let hits;
        try {
          const { exists } = await client.collectionExists(name);
          if (!exists) {
            fail(`No indexed content found for "${sourceUrl}". Run \`querybase index\` first.`);
          }
          const [questionVector] = await embedTexts(embed, [question], "query");
          hits = await searchSections(client, name, questionVector, topK);
        } catch (err) {
          if (err instanceof Error && (err.message.includes("circuit breaker") || err.message.includes("timeout"))) {
            fail("Vector search unavailable (Qdrant or embedding API down). Try again later.");
          }
          throw err;
        }

        if (!hits || hits.length === 0) {
          fail(`No indexed content found for "${sourceUrl}". Run \`querybase index\` first.`);
        }

        const context = numberHits(hits)
          .map(
            ({ index, hit }) =>
              `[${index}] ${hit.pageUrl}${hit.headingPath ? ` (${hit.headingPath})` : ""}\n${hit.text}`
          )
          .join("\n\n");
        const answer = await generateAnswer(generation, [
          {
            role: "system",
            content:
              "You answer questions about the documentation below. Use only the numbered context. " +
              "Cite sources inline as [n] where n matches the numbered context. " +
              "If the context does not answer the question, say so. Do not invent facts.",
          },
          { role: "user", content: `Question: ${question}\n\nContext:\n${context}` },
        ]);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                question,
                answer,
                sources: numberHits(hits).map(({ index, hit }) => ({
                  index,
                  url: hit.pageUrl,
                  headingPath: hit.headingPath,
                  text: hit.text,
                  score: hit.score,
                })),
              },
              null,
              2
            )
          );
        } else {
          console.log(answer);
          console.log("\nSources:");
          numberHits(hits).forEach(({ index, hit }) => {
            console.log(`  [${index}] ${hit.pageUrl}${hit.headingPath ? ` # ${hit.headingPath}` : ""}`);
          });
        }
      } finally {
        await store.close();
      }
    });
}
