# 0007-secrets-backup. Secret rotation and backup/restore

## Summary
Add secret rotation with grace period, and backup/restore commands using pg_dump/pg_restore.

## Requirements
- **AC-6**: `querybase rotate-key <provider>` reads `NEW_<PROVIDER>_KEY` from env, writes to `credentials` with `previous_value` and `rotated_at`. 24h grace period accepts both old/new. Cleanup job removes expired `previous_value`.
- **AC-7**: `querybase backup` → `pg_dump` to stdout (requires quiesce). `querybase restore` → `pg_restore` from stdin. Both exit 1 on error.

## Decision

### Migration
**`migrations/003_credential_rotation.sql`**
```sql
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS previous_value text;
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS rotated_at timestamptz;
-- Index for cleanup job
CREATE INDEX IF NOT EXISTS idx_credentials_rotated_at ON credentials (rotated_at) WHERE rotated_at IS NOT NULL;
```

### Credentials rotation (`src/lib/credentials.ts` modifications)
```ts
// Add to existing credentials logic
export async function rotateKey(provider: "brightdata" | "qdrant" | "embedding", newValue: string) {
  const graceHours = parseInt(process.env.SECRET_GRACE_PERIOD_HOURS || "24", 10);
  const rotatedAt = new Date();
  const expiresAt = new Date(rotatedAt.getTime() + graceHours * 3600 * 1000);

  await pool.query(
    `UPDATE credentials
     SET previous_value = value,
         value = $1,
         rotated_at = $2
     WHERE provider = $3`,
    [newValue, rotatedAt, provider]
  );

  // Schedule cleanup (or run via cron)
  return { rotatedAt, expiresAt };
}

export async function getCredentialWithGrace(provider: string) {
  const result = await pool.query(
    `SELECT value, previous_value, rotated_at FROM credentials WHERE provider = $1`,
    [provider]
  );
  const row = result.rows[0];
  if (!row) return null;

  const now = new Date();
  const graceHours = parseInt(process.env.SECRET_GRACE_PERIOD_HOURS || "24", 10);
  const gracePeriodMs = graceHours * 3600 * 1000;

  // Accept current or previous if within grace period
  return {
    current: row.value,
    previous: row.previous_value,
    previousValid: row.rotated_at && (now.getTime() - new Date(row.rotated_at).getTime()) < gracePeriodMs,
  };
}

export async function cleanupExpiredSecrets() {
  const graceHours = parseInt(process.env.SECRET_GRACE_PERIOD_HOURS || "24", 10);
  const cutoff = new Date(Date.now() - graceHours * 3600 * 1000);
  await pool.query(
    `UPDATE credentials SET previous_value = NULL WHERE rotated_at IS NOT NULL AND rotated_at < $1`,
    [cutoff]
  );
}
```

### Backup/Restore (`src/lib/backup.ts`)
```ts
import { spawn } from "node:child_process";
import { databaseUrl } from "./source.js";

export async function backup(): Promise<ReadableStream> {
  // Check for running operations
  const running = await pool.query(`SELECT 1 FROM meta WHERE key IN ('crawl_running', 'index_running') AND value = 'true'`);
  if (running.rows.length > 0) {
    throw new Error("cannot backup while crawl or index is running");
  }

  const url = new URL(databaseUrl);
  const args = [
    "--no-owner", "--no-privileges",
    "--host", url.hostname,
    "--port", url.port || "5432",
    "--username", url.username,
    "--dbname", url.pathname.slice(1),
  ];
  if (url.password) process.env.PGPASSWORD = url.password;

  const proc = spawn("pg_dump", args, { stdio: ["ignore", "pipe", "pipe"] });
  return new ReadableStream({
    start(controller) {
      proc.stdout.on("data", chunk => controller.enqueue(chunk));
      proc.stderr.on("data", chunk => controller.error(new Error(chunk.toString())));
      proc.on("close", code => code === 0 ? controller.close() : controller.error(new Error(`pg_dump exited with ${code}`)));
    }
  });
}

export async function restore(input: ReadableStream): Promise<void> {
  const url = new URL(databaseUrl);
  const args = [
    "--clean", "--if-exists",
    "--host", url.hostname,
    "--port", url.port || "5432",
    "--username", url.username,
    "--dbname", url.pathname.slice(1),
  ];
  if (url.password) process.env.PGPASSWORD = url.password;

  const proc = spawn("pg_restore", args, { stdio: ["pipe", "pipe", "pipe"] });
  // Pipe input to proc.stdin
  // ... stream piping logic
}
```

### Commands
- `src/commands/rotate-key.ts` — args: `<provider>`, reads `NEW_<PROVIDER>_KEY` from env
- `src/commands/backup.ts` — streams pg_dump to stdout
- `src/commands/restore.ts` — streams stdin to pg_restore

### Cleanup job
Run `cleanupExpiredSecrets()` on container startup (in entrypoint) and/or via cron.

## Build plan
- [ ] Create `migrations/003_credential_rotation.sql`
- [ ] Modify `src/lib/credentials.ts` with rotation logic
- [ ] Create `src/lib/backup.ts`
- [ ] Create `src/commands/rotate-key.ts`
- [ ] Create `src/commands/backup.ts`
- [ ] Create `src/commands/restore.ts`
- [ ] Add `SECRET_GRACE_PERIOD_HOURS` env var
- [ ] Add cleanup to container entrypoint

## Consequences
- Secret rotation zero-downtime (24h overlap)
- Backup requires quiesce (no concurrent crawl/index)
- Standard tools, portable across Postgres versions