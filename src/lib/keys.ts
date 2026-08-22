import type { Store } from "./store.js";
import type { CredentialProvider, AccountRow } from "../types.js";
import { CREDENTIAL_PROVIDERS } from "../types.js";

export type { CredentialProvider } from "../types.js";
import { query } from "./store-pool.js";
import { childLogger } from "./logger.js";

const log = childLogger("credentials");

const ENV_VAR: Record<CredentialProvider, string> = {
  brightdata: "BRIGHTDATA_API_KEY",
  qdrant: "QDRANT_API_KEY",
  embed: "EMBEDDING_API_KEY",
};

export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file present, environment variables are enough
  }
}

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export async function requireUser(
  store: Store
): Promise<{ id: string; username: string }> {
  const current = await store.getCurrentUser();
  if (!current) fail("You must be logged in. Run `querybase login <username>` first.");
  const user = await store.getUserByUsername(current.username);
  if (!user) fail("Your session is invalid. Run `querybase login <username>` again.");
  return { id: user.id, username: user.username };
}

export async function resolveKey(
  store: Store,
  provider: CredentialProvider
): Promise<string | null> {
  const fromEnv = process.env[ENV_VAR[provider]];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const current = await store.getCurrentUser();
  if (!current) return null;
  const user = await store.getUserByUsername(current.username);
  if (!user) return null;
  return store.getCredential(user.id, provider);
}

export async function requireKey(
  store: Store,
  provider: CredentialProvider,
  purpose: string
): Promise<string> {
  const key = await resolveKey(store, provider);
  if (!key) {
    fail(
      `Missing the ${provider} key, needed for ${purpose}. ` +
        `Set ${ENV_VAR[provider]} in the environment, or run ` +
        `\`querybase set-key ${provider} <key>\`.`
    );
  }
  return key;
}

export function isCredentialProvider(value: string): value is CredentialProvider {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

export async function getCredentialWithGrace(
  userId: string,
  provider: CredentialProvider
): Promise<{
  current: string | null;
  previous: string | null;
  previousValid: boolean;
}> {
  const result = await query(
    `SELECT api_key, previous_value, rotated_at FROM credentials WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
  const row = result.rows[0];
  if (!row) return { current: null, previous: null, previousValid: false };

  const graceHours = parseInt(process.env.SECRET_GRACE_PERIOD_HOURS || "24", 10);
  const gracePeriodMs = graceHours * 3600 * 1000;
  const now = Date.now();
  const rotatedAt = row.rotated_at ? new Date(row.rotated_at).getTime() : 0;
  const previousValid = row.rotated_at && (now - rotatedAt) < gracePeriodMs;

  return {
    current: row.api_key,
    previous: row.previous_value,
    previousValid,
  };
}

export async function rotateKey(
  userId: string,
  provider: CredentialProvider,
  newValue: string
): Promise<{
  rotatedAt: Date;
  expiresAt: Date;
}> {
  const graceHours = parseInt(process.env.SECRET_GRACE_PERIOD_HOURS || "24", 10);
  const rotatedAt = new Date();
  const expiresAt = new Date(rotatedAt.getTime() + graceHours * 3600 * 1000);

  await query(
    `UPDATE credentials
     SET previous_value = api_key,
         api_key = $1,
         rotated_at = $2
     WHERE user_id = $3 AND provider = $4`,
    [newValue, rotatedAt, userId, provider]
  );

  log.info({ userId, provider }, "rotated key");
  return { rotatedAt, expiresAt };
}

export function getEnvVar(provider: CredentialProvider): string {
  return ENV_VAR[provider];
}