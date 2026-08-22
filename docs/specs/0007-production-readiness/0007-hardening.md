# 0007-hardening. Circuit breakers, graceful degradation, auto-migrations

## Summary
Add timeout/retry/circuit breaker to all external clients, graceful degradation for `ask`, startup config validation, auto-migration on container startup, and version command.

## Requirements
- **AC-9**: Container entrypoint runs migrations before CLI starts. Migrations idempotent (`IF NOT EXISTS`), transactional.
- **AC-10**: `ask` fails fast if Qdrant/embedding down. `crawl`/`index` continue (Postgres only). All external calls: timeout 30s, retry 3x exp backoff, circuit breaker opens after 5 failures in 30s.

## Decision

### Circuit breaker utility (`src/lib/circuit-breaker.ts`)
```ts
export class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly threshold = 5,
    private readonly windowMs = 30_000,
    private readonly resetTimeoutMs = 30_000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        throw new Error("circuit breaker open");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }
}

// Global instances per external service
export const qdrantBreaker = new CircuitBreaker();
export const embeddingBreaker = new CircuitBreaker();
export const scraperStudioBreaker = new CircuitBreaker();
export const brightDataBreaker = new CircuitBreaker();
```

### Retry wrapper (`src/lib/retry.ts`)
```ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; maxDelayMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 1000, maxDelayMs = 30_000, timeoutMs = 30_000 } = options;
  let lastError: Error;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs)
        ),
      ]);
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries) {
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}
```

### Apply to external clients
- `src/lib/vector.ts` — wrap Qdrant calls with `qdrantBreaker.execute(() => withRetry(...))`
- `src/lib/embedder.ts` — wrap NVIDIA calls with `embeddingBreaker.execute(() => withRetry(...))`
- `src/lib/scraper-studio.ts` — wrap Bright Data calls with `scraperStudioBreaker.execute(() => withRetry(...))`
- `src/lib/fetcher.ts` — wrap SDK calls with `brightDataBreaker.execute(() => withRetry(...))`

### Graceful degradation
```ts
// In ask command
try {
  const results = await qdrantBreaker.execute(() => withRetry(() => qdrantClient.search(...)));
} catch (err) {
  if (err.message.includes("circuit breaker") || err.message.includes("timeout")) {
    throw new Error("vector search unavailable (Qdrant down), try again later");
  }
  throw err;
}

// crawl/index only need Postgres — they continue even if Qdrant/embedding down
```

### Startup config validation (`src/lib/config.ts`)
```ts
export function validateConfig() {
  const required = [
    "DATABASE_URL",
    "BRIGHTDATA_API_KEY",
    "BRIGHTDATA_WEB_UNLOCKER_ZONE",
    "QDRANT_URL",
    "QDRANT_API_KEY",
    "EMBEDDING_API_KEY",
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}
```

### Auto-migration entrypoint (`docker-entrypoint.sh`)
```bash
#!/usr/bin/env bash
set -euo pipefail

# Run migrations
if [ -d "migrations" ]; then
  for f in migrations/*.sql; do
    echo "Running migration: $f"
    psql "$DATABASE_URL" -f "$f" -v ON_ERROR_STOP=1
  done
fi

# Start the CLI
exec "$@"
```

Update `Dockerfile`:
```dockerfile
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["querybase"]
```

### Version command (`src/commands/version.ts`)
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));

export default function versionCommand() {
  console.log(`querybase ${pkg.version}`);
  console.log(`Node ${process.version}`);
  console.log(`Platform ${process.platform}/${process.arch}`);
}
```

## Build plan
- [ ] Create `src/lib/circuit-breaker.ts`
- [ ] Create `src/lib/retry.ts`
- [ ] Wrap Qdrant client in `src/lib/vector.ts`
- [ ] Wrap embedder in `src/lib/embedder.ts`
- [ ] Wrap scraper-studio in `src/lib/scraper-studio.ts`
- [ ] Wrap fetcher in `src/lib/fetcher.ts`
- [ ] Add graceful degradation to `ask` command
- [ ] Create `src/lib/config.ts` with validation
- [ ] Create `docker-entrypoint.sh` with migration runner
- [ ] Update `Dockerfile` to use entrypoint
- [ ] Create `src/commands/version.ts`
- [ ] Wire version command in `src/index.ts`

## Consequences
- External call latency increases slightly (retry overhead)
- Circuit breaker prevents cascade failures
- `ask` fails fast with clear message when vector layer down
- Migrations run automatically, zero manual steps
- Version command useful for debugging container images