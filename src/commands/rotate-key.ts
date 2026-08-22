import { Command } from "commander";
import { loadEnv, requireUser, rotateKey, getEnvVar, CredentialProvider } from "../lib/keys.js";

export function rotateKeyCommand(program: Command): Command {
  return program
    .command("rotate-key <provider>")
    .description("Rotate an API key with grace period (brightdata, qdrant, embed)")
    .action(async (provider: string) => {
      loadEnv();
      if (!["brightdata", "qdrant", "embed"].includes(provider)) {
        console.error(`error: unknown provider "${provider}". Use one of: brightdata, qdrant, embed`);
        process.exit(1);
      }
      const envVar = getEnvVar(provider as CredentialProvider);
      const newValue = process.env[`NEW_${envVar}`];
      if (!newValue) {
        console.error(`error: NEW_${envVar} environment variable not set`);
        process.exit(1);
      }
      const store = (await import("../lib/store.js")).storeFromEnv();
      try {
        await store.init();
        const user = await requireUser(store);
        const { rotatedAt, expiresAt } = await rotateKey(user.id, provider as CredentialProvider, newValue.trim());
        console.log(`Rotated ${provider} key for user ${user.username}`);
        console.log(`  Effective: ${rotatedAt.toISOString()}`);
        console.log(`  Grace period ends: ${expiresAt.toISOString()} (old key still accepted until then)`);
      } finally {
        await store.close();
      }
    });
}