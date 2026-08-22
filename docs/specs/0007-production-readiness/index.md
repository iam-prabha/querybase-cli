# 0007. Production readiness

**Status**: In Progress

## Summary
Add production hardening to the existing prototype: structured logging, metrics, health checks, rate limiting, audit logging, secret rotation, backup/restore, and a CI/CD staging pipeline. Single-tenant, small scale (<10 sources, <100K vectors, <10 QPS), observable baseline. No compliance requirements.

## Requirements

### AC-1: Structured logging
`pino` logger replaces `console.log/error`. JSON output in production, pretty print in development. Child loggers per command (`crawl`, `index`, `ask`, `health`, `metrics`, `rotate-key`, `backup`, `restore`, `audit-log`, `rate-limit`).

### AC-2: Metrics endpoint
`prom-client` registry exposes `/metrics` (Prometheus format) and a `querybase metrics` command. Counters: `crawl_total`, `index_total`, `ask_total`, `errors_total`, `rate_limit_exceeded_total`. Histograms: `crawl_duration_seconds`, `index_duration_seconds`, `ask_duration_seconds`, `embedding_latency_seconds`, `qdrant_latency_seconds`, `scraper_studio_latency_seconds`.

### AC-3: Health command
`querybase health` runs rich dependency checks: Postgres (ping + latency), Qdrant (cluster health + latency), embedding API (ping + latency), Scraper Studio (reachable), disk usage, memory usage. Returns structured output with `status: ok|degraded|down` per dependency and overall. Exit code 0 for ok, 1 for degraded, 2 for down.

### AC-4: Rate limiting
Postgres-backed token bucket per user + endpoint (`crawl`, `index`, `ask` separate buckets). On exceed: return 429 with `Retry-After` seconds. CLI prints human message. Survives restarts.

### AC-5: Audit logging
`audit_logs` table: `id, timestamp, user_id, action, resource_type, resource_id, metadata(jsonb)`. Indexes on `(user_id, timestamp)` and `(resource_type, resource_id)`. Middleware wraps every command: writes `start` on entry, `complete` or `failure` on exit with duration and error. `querybase audit-log` command with filters (`--user`, `--action`, `--since`, `--limit`).

### AC-6: Secret rotation
`querybase rotate-key <provider>` where provider is `brightdata`, `qdrant`, or `embedding`. Reads new value from env (`NEW_BRIGHTDATA_API_KEY` etc.), writes to `credentials` table with `previous_value` = old value, `rotated_at` = now. Grace period: accept both old and new for 24 hours (configurable via `SECRET_GRACE_PERIOD_HOURS`). Cleanup job removes `previous_value` after grace period.

### AC-7: Backup/restore
`querybase backup` → `pg_dump --no-owner --no-privileges` to stdout. Requires quiesce (no active `crawl`/`index`); checks `meta` table for running ops. `querybase restore` → reads stdin, runs `pg_restore --clean --if-exists`. Validates schema version. Both commands exit 1 on error with clear message.

### AC-8: CI/CD staging pipeline
GitHub Actions workflow: test → build → staging deploy → manual promote → prod. Staging uses modified `docker-compose.prod.yml` with fixed ports for test access. Smoke tests run `health`, `init`, `crawl`, `index`, `ask` against a test source. Promotion is a `workflow_dispatch` that tags and pushes `ghcr.io/iam-prabha/querybase:latest`.

### AC-9: Auto-migration on startup
Container entrypoint runs pending migrations before starting the CLI. Migrations are idempotent (`IF NOT EXISTS`), run in transaction. Three migrations: `001_audit_logs`, `002_rate_limits`, `003_credential_rotation`.

### AC-10: Graceful degradation
`ask` fails with clear error if Qdrant or embedding API down. `crawl` and `index` still work (Postgres only). All external calls wrapped with timeout (30s), retry (3x exponential backoff), circuit breaker (open after 5 failures in 30s).

## Decision

### Architecture
Cross-cutting enhancement adding observability, reliability, and operability layers to the existing CLI. No new external services. All state in Postgres.

### Data model additions
**Table: `audit_logs`**
- `id` uuid pk default gen_random_uuid()
- `timestamp` timestamptz not null default now()
- `user_id` uuid not null references `accounts(id)`
- `action` text not null (e.g., `crawl.start`, `index.complete`, `ask.failure`)
- `resource_type` text (e.g., `source`, `page`, `collection`)
- `resource_id` text
- `metadata` jsonb not null default '{}'
- Index: `idx_audit_logs_user_time` on `(user_id, timestamp desc)`
- Index: `idx_audit_logs_resource` on `(resource_type, resource_id)`

**Table: `rate_limit_buckets`**
- `user_id` uuid not null references `accounts(id)`
- `endpoint` text not null (`crawl`, `index`, `ask`)
- `tokens` integer not null default 100
- `refilled_at` timestamptz not null default now()
- Primary key: `(user_id, endpoint)`
- Refill rate: 10 tokens/minute per bucket (configurable via `RATE_LIMIT_REFILL_RATE`)

**Table: `credentials` additions**
- `previous_value` text (encrypted, nullable)
- `rotated_at` timestamptz (nullable)

### Stack & tool choices
- **Logging**: `pino` (fast, JSON, child loggers, pretty dev)
- **Metrics**: `prom-client` (Prometheus standard, simple)
- **Rate limiting**: Postgres-backed token bucket (survives restarts, no Redis)
- **Secret rotation**: Env var + CLI command (zero external deps)
- **Backup/restore**: `pg_dump`/`pg_restore` via CLI (standard tools)
- **CI/CD**: GitHub Actions (existing workflow extended)
- **Staging**: Modified `docker-compose.prod.yml` with fixed ports

### API surface additions
| Command | Description | Output |
|---------|-------------|--------|
| `health` | Rich dependency health check | Structured, `--json` |
| `metrics` | Print Prometheus metrics | Prometheus text format |
| `rotate-key <provider>` | Rotate secret with grace period | Confirmation |
| `backup` | Dump full DB to stdout | SQL dump |
| `restore` | Restore from stdin | Confirmation |
| `audit-log` | Query audit events | Table, `--json` |
| `rate-limit status` | Show bucket states | Table, `--json` |

### Configuration
New optional env vars:
- `LOG_LEVEL` (default `info`, `debug` in dev)
- `RATE_LIMIT_REFILL_RATE` (default 10/min)
- `RATE_LIMIT_BURST` (default 100)
- `SECRET_GRACE_PERIOD_HOURS` (default 24)
- `HEALTH_CHECK_TIMEOUT` (default 10s)

## Build plan

### Phase 1: Observability foundation
- [x] Add `pino`, `prom-client` to dependencies
- [x] Create `src/lib/logger.ts` — pino wrapper with child loggers
- [x] Create `src/lib/metrics.ts` — prom-client registry with counters/histograms
- [x] Create `src/lib/health.ts` — dependency check functions
- [x] Create `src/commands/health.ts` — CLI command
- [x] Create `src/commands/metrics.ts` — CLI command
- [x] Wire commands in `src/index.ts`
- [x] Add `LOG_LEVEL` env handling

### Phase 2: Rate limiting & audit logging
- [x] Migration `001_audit_logs.sql`
- [x] Migration `002_rate_limits.sql`
- [x] Create `src/lib/audit.ts` — audit log writer middleware
- [x] Create `src/lib/rate-limit.ts` — Postgres token bucket
- [x] Wrap all commands with audit + rate limit middleware
- [x] Create `src/commands/audit-log.ts`
- [x] Create `src/commands/rate-limit.ts`

### Phase 3: Secret rotation & backup/restore
- [x] Migration `003_credential_rotation.sql`
- [x] Create `src/lib/credentials.ts` — rotation logic, grace period check
- [x] Create `src/lib/backup.ts` — pg_dump/pg_restore wrappers
- [x] Create `src/commands/rotate-key.ts`
- [x] Create `src/commands/backup.ts`
- [x] Create `src/commands/restore.ts`
- [x] Add cleanup job for expired `previous_value` (CLI command `cleanup-expired-secrets`)

### Phase 4: CI/CD staging
- [x] Modify `.github/workflows/publish.yml` → rename to `ci.yml`, add staging job
- [x] Modify `docker-compose.prod.yml` for staging (Qdrant local mode, profiles)
- [x] Add smoke test script (`scripts/smoke-test.sh`)
- [x] Add `workflow_dispatch` promote job with tag input

### Phase 5: Cross-cutting hardening
- [x] Add timeout/retry/circuit breaker to Qdrant, NVIDIA, Bright Data clients
- [x] Implement graceful degradation: `ask` fails fast, `crawl`/`index` continue
- [x] Startup config validation (required env vars)
- [x] Entrypoint auto-migration runner
- [x] `querybase version` command

## Consequences

### Positive
- Observable: logs, metrics, health checks enable debugging and alerting
- Reliable: rate limits protect resources, circuit breakers prevent cascade failures
- Operable: secret rotation without downtime, backup/restore for disaster recovery
- Deployable: staging pipeline catches regressions before prod

### Negative
- Added dependencies: `pino`, `prom-client` (~50KB total)
- Postgres-backed rate limit adds ~2ms per request (single-row `SELECT FOR UPDATE`)
- Audit log growth: ~1 row per command invocation; 30-day partition + cleanup needed
- More env vars to configure (all optional with sensible defaults)

### Migration risk
Low: all migrations use `IF NOT EXISTS`, run in transaction, no data loss. Rollback = drop new tables/columns.

## Follow-up
- [ ] Add log aggregation (Loki/ELK) when scale grows
- [ ] Add distributed tracing (OpenTelemetry) for multi-service debugging
- [ ] Admin UI for audit logs, rate limits, health history
- [ ] Multi-tenant isolation (separate Qdrant collections per tenant)
- [ ] Cost tracking per source (Scraper Studio credits, embedding calls)

## Structure
- [0007-observability.md](0007-observability.md) — Phase 1: logging, metrics, health
- [0007-rate-limit-audit.md](0007-rate-limit-audit.md) — Phase 2: rate limiting, audit logs
- [0007-secrets-backup.md](0007-secrets-backup.md) — Phase 3: rotation, backup/restore
- [0007-ci-cd-staging.md](0007-ci-cd-staging.md) — Phase 4: GitHub Actions staging
- [0007-hardening.md](0007-hardening.md) — Phase 5: circuit breakers, graceful degradation, migrations

## Rationale
See `rationale.md` for full options considered and references.