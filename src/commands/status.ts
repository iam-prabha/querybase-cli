import type { Command } from "commander";
import { storeFromEnv } from "../lib/store.js";
import { loadEnv, resolveKey } from "../lib/keys.js";
import { collectionName } from "../lib/vector.js";
import { META_KEYS } from "../types.js";

export function statusCommand(program: Command): Command {
  return program
    .command("status")
    .description("Show the source, counts, and configuration")
    .action(async () => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        const sourceUrl = (await store.getMeta(META_KEYS.SOURCE_URL)) ?? "(not initialized)";
        const sourceType = (await store.getMeta(META_KEYS.SOURCE_TYPE)) ?? "-";
        const pages = await store.pageCount();
        const pending = (await store.pendingIndexPages()).length;
        console.log(`Source:      ${sourceUrl}`);
        console.log(`Type:        ${sourceType}`);
        console.log(`Users:       ${await store.userCount()}`);
        console.log(`Pages:       ${pages} (${pages - pending} indexed, ${pending} pending)`);
        console.log(`Storage:     Postgres`);
        const genBase = (
          process.env.GENERATION_BASE_URL ?? "https://integrate.api.nvidia.com/v1"
        ).replace(/\/+$/, "");
        const genProvider = genBase.includes("integrate.api.nvidia.com")
          ? "NVIDIA NIM"
          : "OpenAI compatible";
        const genModel =
          process.env.GENERATION_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1";
        console.log(`Generation:  ${genModel} (${genProvider})`);
        console.log(
          `Embedding:   ${process.env.EMBEDDING_MODEL ?? "text-embedding-3-small"} @ ${
            process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1"
          }`
        );
        if (sourceUrl !== "(not initialized)") {
          console.log(`Collection:  ${collectionName(sourceUrl)}`);
        }
        const keys = (
          await Promise.all(
            (["brightdata", "qdrant", "embed"] as const).map(async (p) => [
              p,
              (await resolveKey(store, p)) ? "set" : "missing",
            ] as const)
          )
        )
          .map(([p, v]) => `${p}: ${v}`)
          .join(", ");
        console.log(`Keys:        ${keys}`);
      } finally {
        await store.close();
      }
    });
}
