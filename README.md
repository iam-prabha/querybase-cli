# querybase

Docs site to RAG pipeline: point a sitemap scraper at any docs site, get structured JSON, chunk, embed, and chat with citations. Users bring their own model API keys.

## Requirements

- Node 24+
- Docker (for the Postgres store)
- API keys: Bright Data, Qdrant cloud, NVIDIA NIM (embeddings and chat)
- `npm run dev -- <command>` or `npm link`

## Setup

```bash
npm install
docker compose up -d
cp .env.example .env   # then fill in your keys
npm run build
```

## Commands

```bash
querybase signup <your_username>   # create an account and log in
querybase login <your_username>    # log in to an existing account
querybase logout                    # end the session
querybase whoami                    # show current user

querybase crawl https://docs.anthropic.com/en/docs   # set source and fetch every page
querybase status              # pages, pending count, keys, collection
querybase index               # section, chunk, embed, and store vectors (slow; run in background)
querybase index --rebuild     # wipe the collection and re index every page
querybase ask "how do I use the messages API?"
querybase ask --json "how do I use the messages API?"   # one JSON document with the answer and its sources
# Note: sources[i].headingPath is an empty string when the section has no heading
```

Keys resolve from environment variables first, then your stored keys:

```bash
querybase set-key brightdata <key>
querybase set-key qdrant <key>
querybase set-key embed <key>
querybase unset-key embed
```

Production commands:

```bash
querybase rate-limit [user]   # show rate limit bucket state per endpoint
querybase rotate-key <provider>  # rotate secret with 24h grace period (brightdata, qdrant, embed)
querybase version             # version, Node, platform
```

## How it works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER'S API KEYS (per user)                          │
│  querybase set-key brightdata <key>   │  querybase set-key qdrant <key>    │
│  querybase set-key embed <key>        │  querybase set-key embed <key>     │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         QUERYBASE SERVICE                                   │
│  • Reads user's keys from Postgres at request time (no platform keys)       │
│  • Embedding: user's key from Postgres at request time                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                     ┌─────────────────┼─────────────────┐
                     ▼                 ▼                 ▼
             ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
             │   Postgres    │ │    Qdrant     │ │   Embedding   │
             │  (user keys,  │ │  (vectors,    │ │  (user's key, │
             │   meta, pg)   │ │   metadata)   │ │  connectivity)│
             └───────────────┘ └───────────────┘ └───────────────┘
                     │                 │                 │
                     ▼                 ▼                 ▼
             ┌─────────────────────────────────────────────────────────────┐
             │                    SCRAPER STUDIO                            │
             │  (Bright Data collector, user's key at request time)        │
             └─────────────────────────────────────────────────────────────┘
```

- **Discover** the page list from `llms.txt` (or `llms-full.txt`) at the site root, falling back to `sitemap.xml`, for the path you gave and the origin root.
- **Fetch** every page through a Bright Data Scraper Studio collector built for that source: the collector is generated once on the first crawl (plain English description, 5 to 10 minutes), then rerun in one batch per crawl. Extractions are reassembled into markdown. Pages that come back empty trigger a collector self heal, and pages that still fail fall back to the Bright Data SDK, which is also the safety net if Scraper Studio is unavailable. Markdown sources stay as-is; HTML is converted to markdown with turndown.
- **Section** each page on its headings with remark, then **chunk** long sections to a token budget so they fit the embedding model.
- **Embed** each chunk with NVIDIA NIM `nvidia/nv-embedqa-e5-v5` (passage mode when indexing, query mode when asking). User's key from Postgres at request time. Circuit breaker + retry on embedding API.
- **Store** the vectors in Qdrant cloud; pages, accounts, and meta in Postgres. Circuit breaker + retry on Qdrant.
- **Ask** embeds your question, retrieves the closest sections, and has the chat model write a grounded answer with a Sources list of real page urls and heading paths. Add `--json` to print the answer and its sources as one machine readable JSON document on stdout (errors still go to stderr with exit code 1).
- **Reliability**: per-source collector with self-heal + SDK fallback; Postgres-backed rate limiting per user+endpoint (token consumed after successful command); secret rotation with 24h grace period; index advisory lock prevents concurrent runs; crawl uses transaction for atomic page saves; circuit breakers on all external calls; graceful degradation (`ask` fails fast if vector layer down, `crawl`/`index` continue).

## Configuration

All configuration lives in `.env` (see `.env.example`). The important keys:

| Variable | Purpose |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Postgres credentials (compose maps port 5433) |
| `BRIGHTDATA_API_KEY`, `BRIGHTDATA_WEB_UNLOCKER_ZONE` | page fetch |
| `QDRANT_URL`, `QDRANT_API_KEY` | vector storage |
| `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | embeddings |
| `GENERATION_BASE_URL`, `GENERATION_MODEL` | chat, defaults to NVIDIA NIM |
| `ASK_TOP_K` | sections retrieved per question (default 5) |
| `SCRAPER_MIN_USABLE_TEXT_LENGTH`, `SCRAPER_HEAL_MIN_FAILURES`, `SCRAPER_MAX_HEALS`, `SCRAPER_GENERATION_TIMEOUT`, `SCRAPER_DATASET_TIMEOUT`, `SCRAPER_POLL_INTERVAL` | Scraper Studio tuning (optional, sensible defaults) |
| `LOG_LEVEL` | `info` (prod) or `debug` (dev) |
| `RATE_LIMIT_REFILL_RATE` | tokens per minute per endpoint (default 10) |
| `RATE_LIMIT_BURST` | max burst per bucket (default 100) |
| `SECRET_GRACE_PERIOD_HOURS` | rotation overlap window (default 24) |

## Notes

- Indexing is slow because NVIDIA embeds one call at a time. For a big site run `index` in the background (`nohup querybase index > index.log &`) and poll `querybase status`; interrupted runs resume where they left off.
- Do not run two querybase commands at once; parallel writes to the meta table can corrupt the session and source.
- **Users bring their own API keys** - stored in Postgres per user via `querybase set-key`.
- The `crawl` command requires a URL argument and automatically sets the source.

## Run with Docker

querybase ships as a container image on Docker Hub. Every version tag push builds and publishes `iamprabha010/querybase`, tagged with the version and `latest`.

Build it yourself:

```bash
docker build -t querybase .
```

Run from the registry. All keys come from the environment, using the same variables as `.env.example`:

```bash
docker run --rm \
  -e DATABASE_URL=postgres://querybase:change-me@host.docker.internal:5433/querybase \
  -e BRIGHTDATA_API_KEY=... \
  -e BRIGHTDATA_WEB_UNLOCKER_ZONE=... \
  -e QDRANT_URL=... \
  -e QDRANT_API_KEY=... \
  -e EMBEDDING_API_KEY=... \
  iamprabha010/querybase status

docker run --rm -e ... iamprabha010/querybase ask "how do I use the API?"
```

Interactive commands (`signup`, `login`, `set-key`) prompt for input, so add `-it`:

```bash
docker run --rm -it -e ... iamprabha010/querybase login <username>
```

Two notes for the container:

- A container cannot reach your host's `localhost`. Point `DATABASE_URL` at the host gateway address, `host.docker.internal`. On Linux, pass `--add-host=host.docker.internal:host-gateway`; on Docker Desktop it works out of the box.
- Indexing stays slow inside the container too, so run `index` detached and poll `status`.

### Self contained stack

`docker-compose.yml` bundles the CLI with its own Postgres, so you do not need the local dev Postgres (or `host.docker.internal`) at all. The stack Postgres is internal to the compose network, data persists in its own named volume, and every CLI command runs with one command:

```bash
docker compose run --rm querybase status
docker compose run --rm querybase ask "how do I use the API?"
```

Keys come from your existing `.env` (`env_file`). The container's `DATABASE_URL` is derived from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` and points at the stack's `postgres` service, never at a host address. Compose starts Postgres automatically on the first run and reuses it on later runs, so state survives between commands. The stack Postgres does not listen on a host port, so it cannot clash with the dev Postgres on port 5433, and the local dev workflow is untouched.

Interactive commands (`signup`, `login`, `set-key`) need a terminal, so add `-it`:

```bash
docker compose run --rm -it querybase login <username>
```

Two notes:

- `POSTGRES_PASSWORD` is embedded in the derived `DATABASE_URL`, so it must be URL safe (avoid `@`, `:`, `/`).
- The compose file builds the image locally from the repo on first use. Once a version tag is published, you can drop the `build` block and it will pull `iamprabha010/querybase:latest` instead.

## CI/CD Staging Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main`:

1. **Test** — `npm test` + `npx tsc --noEmit`
2. **Build** — `npm run build` + Docker image `querybase:staging`
3. **Staging** — boots stack (Qdrant Cloud), runs health check
4. **Promote** — manual `workflow_dispatch` with tag (e.g., `v1.2.0`) → pushes tag → triggers Docker Hub publish

Required secrets for staging: `DATABASE_URL`, `QDRANT_URL`, `QDRANT_API_KEY`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_WEB_UNLOCKER_ZONE`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_INPUT_TYPE`.

## Development

```bash
npm test           # vitest suite in tests/ (chunking, source detection, scraper studio, integration)
npx tsc --noEmit   # typecheck src (vitest runs the tests, tsc does not typecheck them)
npm run build      # emit dist/ for the global binary
npm run dev -- status
```

Architecture and decisions live in `docs/`.