# 0007-observability. Structured logging, metrics, health checks

## Summary
Add `pino` for structured logging, `prom-client` for Prometheus metrics, and a `health` command with rich dependency checks.

## Requirements
- **AC-1**: `pino` logger replaces `console.log/error`. JSON in prod, pretty in dev. Child loggers per command.
- **AC-2**: `prom-client` registry with counters and histograms for all pipeline stages. `querybase metrics` command prints Prometheus format.
- **AC-3**: `querybase health` checks Postgres, Qdrant, embedding API, Scraper Studio, disk, memory. Returns structured status per dependency. Exit codes: 0=ok, 1=degraded, 2=down.

## Decision

### Logger (`src/lib/logger.ts`)
```ts
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: isDev ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  base: { service: "querybase", version: process.env.npm_package_version },
});

export function childLogger(name: string) {
  return logger.child({ command: name });
}
```

### Metrics (`src/lib/metrics.ts`)
```ts
import { Registry, Counter, Histogram } from "prom-client";

export const register = new Registry();
register.setDefaultLabels({ app: "querybase" });

export const crawlTotal = new Counter({ name: "crawl_total", help: "Total crawl invocations", registers: [register] });
export const indexTotal = new Counter({ name: "index_total", help: "Total index invocations", registers: [register] });
export const askTotal = new Counter({ name: "ask_total", help: "Total ask invocations", registers: [register] });
export const errorsTotal = new Counter({ name: "errors_total", help: "Total errors by type", labelNames: ["command", "error"], registers: [register] });
export const rateLimitExceededTotal = new Counter({ name: "rate_limit_exceeded_total", help: "Rate limit exceeded count", registers: [register] });

export const crawlDuration = new Histogram({ name: "crawl_duration_seconds", help: "Crawl duration", buckets: [1, 5, 10, 30, 60, 300], registers: [register] });
export const indexDuration = new Histogram({ name: "index_duration_seconds", help: "Index duration", buckets: [1, 5, 10, 30, 60, 300, 600], registers: [register] });
export const askDuration = new Histogram({ name: "ask_duration_seconds", help: "Ask duration", buckets: [0.1, 0.5, 1, 2, 5, 10, 30], registers: [register] });
export const embeddingLatency = new Histogram({ name: "embedding_latency_seconds", help: "Embedding API latency", buckets: [0.1, 0.5, 1, 2, 5, 10], registers: [register] });
export const qdrantLatency = new Histogram({ name: "qdrant_latency_seconds", help: "Qdrant latency", buckets: [0.01, 0.05, 0.1, 0.5, 1, 2], registers: [register] });
export const scraperStudioLatency = new Histogram({ name: "scraper_studio_latency_seconds", help: "Scraper Studio latency", buckets: [1, 5, 10, 30, 60, 300, 600], registers: [register] });
```

### Health checks (`src/lib/health.ts`)
```ts
export async function checkHealth() {
  const checks = await Promise.allSettled([
    checkPostgres(),
    checkQdrant(),
    checkEmbeddingApi(),
    checkScraperStudio(),
    checkDisk(),
    checkMemory(),
  ]);

  const results = checks.map((c, i) => c.status === "fulfilled" ? c.value : { name: ["postgres", "qdrant", "embedding", "scraper", "disk", "memory"][i], status: "down", error: c.reason?.message });
  const overall = results.every(r => r.status === "ok") ? "ok" : results.some(r => r.status === "down") ? "down" : "degraded";
  return { overall, checks: results, timestamp: new Date().toISOString() };
}
```

### Commands
- `src/commands/health.ts` — runs `checkHealth()`, prints table or `--json`, exits with code.
- `src/commands/metrics.ts` — prints `register.metrics()` output.

### Configuration
- `LOG_LEVEL` (default `info`, `debug` in dev)
- `HEALTH_CHECK_TIMEOUT` (default 10s)

## Build plan
- [x] Add `pino`, `prom-client`, `pino-pretty` (devDependency) to `package.json`
- [x] Create `src/lib/logger.ts`
- [x] Create `src/lib/metrics.ts`
- [x] Create `src/lib/health.ts`
- [x] Create `src/commands/health.ts`
- [x] Create `src/commands/metrics.ts`
- [x] Wire in `src/index.ts`
- [x] Update `src/types.ts` for health types

## Consequences
- ~50KB added dependencies
- All existing `console.log/error` calls replaced (grep and replace)
- Structured logs enable log aggregation later