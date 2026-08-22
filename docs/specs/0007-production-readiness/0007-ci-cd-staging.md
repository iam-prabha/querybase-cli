# 0007-ci-cd-staging. CI/CD staging pipeline

## Summary
Extend GitHub Actions workflow: test → build → staging deploy → manual promote → prod. Staging uses modified `docker-compose.prod.yml` with fixed ports.

## Requirements
- **AC-8**: GitHub Actions workflow runs test → build → staging deploy → smoke tests → manual promote → prod push.
- Staging uses `docker-compose.prod.yml` with fixed ports for test access.
- Smoke tests: `health` → `init` → `crawl` → `index` → `ask` against test source.
- Promotion via `workflow_dispatch` tags and pushes `ghcr.io/iam-prabha/querybase:latest`.

## Decision

### Workflow (`.github/workflows/ci.yml`)
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
    inputs:
      promote_tag:
        description: "Tag to promote to production (e.g., v1.2.3)"
        required: true
        type: string

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "npm" }
      - run: npm ci
      - run: npm test
      - run: npx tsc --noEmit

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - run: npm run build
      - run: docker build -t querybase:staging .
      - run: docker save querybase:staging | gzip > querybase-staging.tar.gz
      - uses: actions/upload-artifact@v4
        with: { name: querybase-staging, path: querybase-staging.tar.gz }

  staging:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'
    env:
      DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
      BRIGHTDATA_API_KEY: ${{ secrets.BRIGHTDATA_API_KEY }}
      BRIGHTDATA_WEB_UNLOCKER_ZONE: ${{ secrets.BRIGHTDATA_WEB_UNLOCKER_ZONE }}
      QDRANT_URL: ${{ secrets.STAGING_QDRANT_URL }}
      QDRANT_API_KEY: ${{ secrets.STAGING_QDRANT_API_KEY }}
      EMBEDDING_API_KEY: ${{ secrets.EMBEDDING_API_KEY }}
      STAGING_MODE: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: querybase-staging, path: . }
      - run: docker load < querybase-staging.tar.gz
      - run: docker compose -f docker-compose.prod.yml up -d
      - run: sleep 10 && ./scripts/smoke-test.sh
      - run: docker compose -f docker-compose.prod.yml down -v

  promote:
    needs: staging
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: git tag ${{ github.event.inputs.promote_tag }}
      - run: git push origin ${{ github.event.inputs.promote_tag }}
      # The existing publish.yml triggers on tag push to GHCR

  # Keep the original publish job for tag pushes
  publish:
    needs: test
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions: { packages: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - run: docker build -t ghcr.io/iam-prabha/querybase:${{ github.ref_name }} -t ghcr.io/iam-prabha/querybase:latest .
      - run: docker push ghcr.io/iam-prabha/querybase:${{ github.ref_name }}
      - run: docker push ghcr.io/iam-prabha/querybase:latest
```

### Staging compose modifications (`docker-compose.prod.yml`)
Add `STAGING_MODE` env var that:
- Exposes Postgres port (e.g., 5434) for test access
- Uses Qdrant local mode (embedded) to avoid cloud cost
- Sets fixed source URL for smoke tests

```yaml
# In docker-compose.prod.yml, add to querybase service:
environment:
  - STAGING_MODE=${STAGING_MODE:-false}
  - QDRANT_URL=${QDRANT_URL:-http://qdrant:6333}
# When STAGING_MODE=true, also expose ports:
ports:
  - "${STAGING_POSTGRES_PORT:-5434}:5432"
```

### Smoke test script (`scripts/smoke-test.sh`)
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Smoke test ==="
docker compose -f docker-compose.prod.yml run --rm querybase health --json
docker compose -f docker-compose.prod.yml run --rm querybase init https://docs.brightdata.com/llms.txt
docker compose -f docker-compose.prod.yml run --rm querybase crawl
docker compose -f docker-compose.prod.yml run --rm querybase index
docker compose -f docker-compose.prod.yml run --rm querybase ask "What is Bright Data?" --json
echo "=== Smoke test passed ==="
```

### Configuration
- `STAGING_MODE` — enables staging modifications in compose
- `STAGING_POSTGRES_PORT` — fixed port for tests (default 5434)
- Qdrant local mode when `STAGING_MODE=true` (no `QDRANT_URL`/`QDRANT_API_KEY` needed)

## Build plan
- [ ] Rename `.github/workflows/publish.yml` → `ci.yml` with above structure
- [ ] Modify `docker-compose.prod.yml` for `STAGING_MODE` support
- [ ] Create `scripts/smoke-test.sh`
- [ ] Add Qdrant local mode support (embedded) for staging
- [ ] Document required secrets for staging (separate from prod)

## Consequences
- Staging runs on every main push, catches regressions early
- Manual promotion ensures intentional releases
- Qdrant local mode eliminates staging cloud cost
- Uses existing GHCR publish on tag push