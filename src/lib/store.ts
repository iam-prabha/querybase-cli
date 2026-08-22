import type { Page, PageRow, Account, AccountRow } from "../types.js";
import { META_KEYS } from "../types.js";
import { query, connect, withTransaction, ping, closePool } from "./store-pool.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS credentials (
    user_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL,
    api_key    TEXT NOT NULL,
    previous_value TEXT,
    rotated_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, provider)
  );
  CREATE TABLE IF NOT EXISTS pages (
    url               TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    markdown          TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    last_indexed_hash TEXT,
    fetched_at        TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    user_id uuid NOT NULL REFERENCES accounts(id),
    endpoint text NOT NULL CHECK (endpoint IN ('crawl', 'index', 'ask')),
    tokens integer NOT NULL DEFAULT 100,
    refilled_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, endpoint)
  );
`;

export function storeFromEnv(): Store {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Missing DATABASE_URL in the environment. Add it to .env or export it, and start Postgres with `docker compose up -d`."
    );
  }
  return new Store();
}

class Store {
  async init(): Promise<void> {
    try {
      await query(SCHEMA);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot connect to Postgres (${message}). Is the container running? Run \`docker compose up -d\`.`
      );
    }
  }

  async getMeta(key: string): Promise<string | null> {
    const res = await query("SELECT value FROM meta WHERE key = $1", [key]);
    return res.rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await query(
      "INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value]
    );
  }

  async clearMeta(key: string): Promise<void> {
    await query("DELETE FROM meta WHERE key = $1", [key]);
  }

  async createUser(username: string, passwordHash: string): Promise<Account> {
    const res = await query(
      `INSERT INTO accounts (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at`,
      [username, passwordHash]
    );
    return { id: res.rows[0].id, username: res.rows[0].username, createdAt: res.rows[0].created_at };
  }

  async getUserByUsername(username: string): Promise<AccountRow | null> {
    const res = await query(
      `SELECT id, username, password_hash AS "passwordHash", created_at AS "createdAt" FROM accounts WHERE username = $1`,
      [username]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.passwordHash,
      createdAt: row.createdAt,
    };
  }

  async getCurrentUser(): Promise<{ username: string; sessionToken: string } | null> {
    const username = await this.getMeta(META_KEYS.CURRENT_USER);
    const sessionToken = await this.getMeta(META_KEYS.SESSION_TOKEN);
    if (!username || !sessionToken) return null;
    return { username, sessionToken };
  }

  async clearCurrentUser(): Promise<void> {
    await query("DELETE FROM meta WHERE key IN ($1, $2)", [
      META_KEYS.CURRENT_USER,
      META_KEYS.SESSION_TOKEN,
    ]);
  }

  async userCount(): Promise<number> {
    const res = await query("SELECT COUNT(*) AS count FROM accounts");
    return Number(res.rows[0]?.count ?? 0);
  }

  async setCredential(userId: string, provider: string, apiKey: string): Promise<void> {
    await query(
      `INSERT INTO credentials (user_id, provider, api_key) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider) DO UPDATE SET api_key = EXCLUDED.api_key`,
      [userId, provider, apiKey]
    );
  }

  async getCredential(userId: string, provider: string): Promise<string | null> {
    const res = await query(
      "SELECT api_key AS \"apiKey\" FROM credentials WHERE user_id = $1 AND provider = $2",
      [userId, provider]
    );
    return res.rows[0]?.apiKey ?? null;
  }

  async unsetCredential(userId: string, provider: string): Promise<void> {
    await query("DELETE FROM credentials WHERE user_id = $1 AND provider = $2", [
      userId,
      provider,
    ]);
  }

  async savePage(page: Page, contentHash: string): Promise<void> {
    const existing = await this.getPage(page.url);
    const fetchedAt = new Date().toISOString();
    if (existing && existing.contentHash === contentHash) {
      await query("UPDATE pages SET fetched_at = $1 WHERE url = $2", [
        fetchedAt,
        page.url,
      ]);
      return;
    }
    await query(
      `INSERT INTO pages (url, title, markdown, content_hash, last_indexed_hash, fetched_at)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (url) DO UPDATE SET
         title = EXCLUDED.title,
         markdown = EXCLUDED.markdown,
         content_hash = EXCLUDED.content_hash,
         last_indexed_hash = NULL,
         fetched_at = EXCLUDED.fetched_at`,
      [page.url, page.title, page.markdown, contentHash, fetchedAt]
    );
  }

  async getPage(url: string): Promise<PageRow | null> {
    const res = await query(
      `SELECT url, title, markdown, content_hash AS "contentHash", last_indexed_hash AS "lastIndexedHash", fetched_at AS "fetchedAt"
       FROM pages WHERE url = $1`,
      [url]
    );
    return (res.rows[0] as PageRow) ?? null;
  }

  async pageCount(): Promise<number> {
    const res = await query("SELECT COUNT(*) AS count FROM pages");
    return Number(res.rows[0]?.count ?? 0);
  }

  async pendingIndexPages(): Promise<PageRow[]> {
    const res = await query(
      `SELECT url, title, markdown, content_hash AS "contentHash", last_indexed_hash AS "lastIndexedHash", fetched_at AS "fetchedAt"
       FROM pages
       WHERE last_indexed_hash IS NULL OR last_indexed_hash != content_hash`
    );
    return res.rows as PageRow[];
  }

  async markPageIndexed(url: string): Promise<void> {
    await query("UPDATE pages SET last_indexed_hash = content_hash WHERE url = $1", [
      url,
    ]);
  }

  async resetPages(): Promise<void> {
    await query("DELETE FROM pages");
  }

  async resetIndexedState(): Promise<void> {
    await query("UPDATE pages SET last_indexed_hash = NULL");
  }

  async close(): Promise<void> {
    await closePool();
  }

  async ping(): Promise<void> {
    await ping();
  }

  async withTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
    return withTransaction(fn);
  }
}

export { Store };
export { query, connect, withTransaction, closePool, ping } from "./store-pool.js";