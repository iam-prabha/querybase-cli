import type { Command } from "commander";
import { storeFromEnv } from "../lib/store.js";
import { isCredentialProvider, loadEnv, requireUser } from "../lib/keys.js";
import { CREDENTIAL_PROVIDERS } from "../types.js";

export function unsetKeyCommand(program: Command): Command {
  return program
    .command("unset-key <provider>")
    .description("Remove a stored API key for the logged in user")
    .action(async (provider: string) => {
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
        await store.unsetCredential(user.id, provider);
        console.log(`Removed the ${provider} key for "${user.username}".`);
      } finally {
        await store.close();
      }
    });
}
