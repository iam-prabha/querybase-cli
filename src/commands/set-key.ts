import type { Command } from "commander";
import { storeFromEnv } from "../lib/store.js";
import { isCredentialProvider, loadEnv, requireUser } from "../lib/keys.js";
import { CREDENTIAL_PROVIDERS } from "../types.js";

export function setKeyCommand(program: Command): Command {
  return program
    .command("set-key <provider> <key>")
    .description("Store an API key for the logged in user (brightdata, qdrant, embed)")
    .action(async (provider: string, key: string) => {
      loadEnv();
      if (!isCredentialProvider(provider)) {
        console.error(
          `error: unknown provider "${provider}". Use one of: ${CREDENTIAL_PROVIDERS.join(", ")}`
        );
        process.exit(1);
      }
      const store = storeFromEnv();
      try {
        await store.init();
        const user = await requireUser(store);
        await store.setCredential(user.id, provider, key.trim());
        console.log(`Stored the ${provider} key for "${user.username}".`);
      } finally {
        await store.close();
      }
    });
}
