import { Pool, PoolClient } from "pg";

let poolInstance: Pool | null = null;

function getConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Missing DATABASE_URL in the environment. Add it to .env or export it, and start Postgres with `docker compose up -d`."
    );
  }
  return connectionString;
}

export function initPool(): void {
  if (!poolInstance) {
    poolInstance = new Pool({ connectionString: getConnectionString() });
  }
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

export async function query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
  initPool();
  const result = await poolInstance!.query(text, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

export async function connect(): Promise<PoolClient> {
  initPool();
  return poolInstance!.connect();
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function ping(): Promise<void> {
  await query("SELECT 1");
}