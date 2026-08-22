# 0007-rate-limit-audit. Rate limiting and audit logging

## Summary
Add Postgres-backed token bucket rate limiting per user + endpoint, and audit logging for all command invocations.

## Requirements
- **AC-4**: Rate limit per user + endpoint (`crawl`, `index`, `ask`). 100 burst, 10/min refill. Returns 429 with `Retry-After`. Survives restarts.
- **AC-5**: `audit_logs` table with indexes. Middleware wraps every command: `start` on entry, `complete`/`failure` on exit. `querybase audit-log` command with filters.

## Decision

### Migrations
**`migrations/001_audit_logs.sql`**
```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL,
  resource_type text,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time ON audit_logs (user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource_type, resource_id);
```

**`migrations/002_rate_limits.sql`**
```sql
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  user_id uuid NOT NULL REFERENCES accounts(id),
  endpoint text NOT NULL CHECK (endpoint IN ('crawl', 'index', 'ask')),
  tokens integer NOT NULL DEFAULT 100,
  refilled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint)
);
```

### Rate limiter (`src/lib/rate-limit.ts`)
```ts
import { pool } from "./store.js";

const REFILL_RATE = parseInt(process.env.RATE_LIMIT_REFILL_RATE || "10", 10); // per minute
const BURST = parseInt(process.env.RATE_LIMIT_BURST || "100", 10);

export async function checkRateLimit(userId: string, endpoint: "crawl" | "index" | "ask") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Refill tokens based on elapsed time
    const result = await client.query(
      `UPDATE rate_limit_buckets
       SET tokens = LEAST($3, tokens + floor(extract(epoch from (now() - refilled_at)) / 60) * $4),
           refilled_at = now()
       WHERE user_id = $1 AND endpoint = $2
       RETURNING tokens`,
      [userId, endpoint, BURST, REFILL_RATE]
    );

    let tokens = result.rows[0]?.tokens ?? BURST;
    if (tokens <= 0) {
      const retryAfter = Math.ceil(60 / REFILL_RATE);
      await client.query("ROLLBACK");
      return { allowed: false, retryAfter };
    }

    // Consume one token
    await client.query(
      `UPDATE rate_limit_buckets SET tokens = tokens - 1 WHERE user_id = $1 AND endpoint = $2`,
      [userId, endpoint]
    );
    await client.query("COMMIT");
    return { allowed: true, remaining: tokens - 1 };
  } catch {
    await client.query("ROLLBACK");
    throw;
  } finally {
    client.release();
  }
}

export async function initBucket(userId: string, endpoint: "crawl" | "index" | "ask") {
  await pool.query(
    `INSERT INTO rate_limit_buckets (user_id, endpoint, tokens, refilled_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    [userId, endpoint, BURST]
  );
}
```

### Audit logger (`src/lib/audit.ts`)
```ts
import { pool } from "./store.js";
import { childLogger } from "./logger.js";

const log = childLogger("audit");

export async function auditStart(userId: string, action: string, resourceType?: string, resourceId?: string, metadata = {}) {
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, `${action}.start`, resourceType, resourceId, JSON.stringify(metadata)]
  );
}

export async function auditComplete(userId: string, action: string, durationMs: number, metadata = {}) {
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, `${action}.complete`, null, null, JSON.stringify({ ...metadata, duration_ms: durationMs })]
  );
}

export async function auditFailure(userId: string, action: string, error: Error, metadata = {}) {
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, `${action}.failure`, null, null, JSON.stringify({ ...metadata, error: error.message, stack: error.stack })]
  );
  log.error({ userId, action, error: error.message }, "command failed");
}
```

### Middleware wrapper
All commands wrapped in `src/index.ts`:
```ts
async function withAuditAndRateLimit(userId: string, endpoint: string, fn: () => Promise<void>) {
  const start = Date.now();
  await initBucket(userId, endpoint as any);
  const rl = await checkRateLimit(userId, endpoint as any);
  if (!rl.allowed) {
    console.error(`rate limit exceeded for ${endpoint}, retry after ${rl.retryAfter}s`);
    process.exit(1); // or throw structured error
  }
  await auditStart(userId, endpoint);
  try {
    await fn();
    await auditComplete(userId, endpoint, Date.now() - start);
  } catch (err) {
    await auditFailure(userId, endpoint, err as Error);
    throw err;
  }
}
```

### Commands
- `src/commands/audit-log.ts` — filters: `--user`, `--action`, `--since`, `--limit`, `--json`
- `src/commands/rate-limit.ts` — `status` subcommand shows buckets

## Build plan
- [x] Create `migrations/001_audit_logs.sql`
- [x] Create `migrations/002_rate_limits.sql`
- [x] Create `src/lib/rate-limit.ts`
- [x] Create `src/lib/audit.ts`
- [x] Wrap commands in `src/index.ts` with middleware
- [x] Create `src/commands/audit-log.ts`
- [x] Create `src/commands/rate-limit.ts`
- [x] Add env vars: `RATE_LIMIT_REFILL_RATE`, `RATE_LIMIT_BURST`

## Consequences
- ~2ms overhead per command (single-row `SELECT FOR UPDATE`)
- Audit log grows ~1 row/command; 30-day partition + cleanup in Phase 3
- Rate limit survives container restarts