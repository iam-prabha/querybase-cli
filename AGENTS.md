# AGENTS.md

Guidance for agent tools working in this repository. Read this before changing code.

## What this project is

querybase is a command line tool (TypeScript, Node, ESM) that turns a documentation website into a searchable knowledge base you can ask questions of. Every answer cites the real page and heading it came from.

Pipeline: discover pages (llms.txt first, sitemap.xml fallback) → fetch each page through a per source Scraper Studio collector (one batch per crawl, self healing, SDK fallback for pages that still fail) → split into sections with remark → chunk long sections to a token budget → embed with NVIDIA NIM `nvidia/nv-embedqa-e5-v5` → store vectors in Qdrant cloud → keep accounts, pages, and meta in Postgres (docker compose) → answer questions with NVIDIA NIM chat and a Sources list.

## Commands

- `npm test` — run the vitest suite (fast, no network; source detection, chunking, integration covered)
- `npx tsc --noEmit` — typecheck
- `npm run build` — emit `dist/` (the global `querybase` binary runs `dist/index.js`, so build after code changes)
- `npm run dev -- <command>` — run a command from source without building, e.g. `npm run dev -- status`

## Structure

- `src/index.ts` — CLI entry, wires commander
- `src/commands/` — one file per subcommand (ask, crawl, index, login, logout, set-key, signup, status, unset-key, whoami, rate-limit, rotate-key, version)
- `src/lib/` — logic: auth, chunk, discovery, embedder, fetcher, generator, keys, scraper-studio, sectioner, source, store, vector, rate-limit, circuit-breaker, retry, logger, turndown
- `src/types.ts` — shared types, credential providers, meta keys
- `tests/` — vitest suites (chunk, source, scraper-studio, integration), kept out of `src` so the build never emits them; vitest runs them, tsc does not typecheck them
- `docs/` — scope and the specs (index, rationale, verify)
- `docker-compose.yml` — dev Postgres on port 5433; querybase service (no profiles)
- `Dockerfile`, `.dockerignore` — multi stage container image; `.github/workflows/publish.yml` publishes it to Docker Hub (iamprabha010) on version tag pushes

## Conventions

- ESM throughout; relative imports carry the `.js` extension (NodeNext)
- No comments unless a non obvious decision needs one; keep them minimal
- Plain console output for the CLI, no logging framework
- Errors exit with code 1 and print `error: ...`
- Secrets live in `.env` (gitignored), never commit them or print them

## Facts that bite

- NVIDIA e5-v5 caps inputs at 512 tokens and needs `input_type: "passage"` when indexing and `"query"` when asking. Sections are chunked (`src/lib/chunk.ts`, `EMBEDDING_MAX_CHUNK_TOKENS`, default 480) and the embedder splits adaptively as a safety net.
- Generation defaults to NVIDIA NIM and always uses the `embed` key. `GENERATION_BASE_URL` and `GENERATION_MODEL` can point at any OpenAI compatible chat endpoint. There is no Groq provider; credential providers are `brightdata`, `qdrant`, `embed`.
- The collection name is a slug of the source url. Switching source wipes the stored pages and forces a rebuild, which creates a new collection.
- Indexing is slow (NVIDIA per call latency). For a big site run `index` in the background with `nohup` and poll `status`; each page commits as it finishes, so interrupted runs resume with plain `index` (no rebuild).
- Do not run querybase commands from a second terminal while `index` or `crawl` runs; the meta table does not lock and parallel writes can corrupt the session and source.
- `index --rebuild` resets every page hash so all pages re index; it also recreates the collection with the `page_url` keyword payload index that filtered deletes require.
- crawl skips unchanged pages by content hash; index skips pages whose hash matches `last_indexed_hash`, so repeated runs cost nothing.
- Crawl fetches through a per source Scraper Studio collector. The first crawl of a source creates it (generation takes 5 to 10 minutes, polled with a `generating collector, polled N of M` note) and stores the id in meta (`scraper_collector_id`); later crawls reuse it and run one batch trigger per crawl. Generation runs against one same-origin discovered page: `automate_template` rejects cross-origin sample urls, and more than one sample can trip a server side error.
- Pages whose extraction is empty or too short trigger a collector heal (`refactor_template`, auto approved) capped per crawl; pages still failing after healing fall back to the SDK `scrapeUrl` path and are skipped with a warning only if that fails too. Transport failures and dataset timeouts skip the heal and go straight to the SDK.
- Extraction yield varies by generation: a weak collector extracts only its sample page, a fresh one everything. If a source extracts poorly, heal with a prompt naming the failing pages, or clear the stored collector id to regenerate (source switch clears it for you).
- The dataset row shape is external: rows carry `title`, `blocks`, `raw_content`, and `input.url`; the mapper prefers `raw_content` (`src/lib/scraper-studio.ts`).
- The required keys are `DATABASE_URL`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_WEB_UNLOCKER_ZONE`, `QDRANT_URL`, `QDRANT_API_KEY`, and `EMBEDDING_API_KEY`; `ASK_TOP_K`, `GENERATION_BASE_URL`, `GENERATION_MODEL`, and the `SCRAPER_*` tuning vars are optional. Copy `.env.example` and fill it in. `SCRAPER_GENERATION_TIMEOUT` defaults to 900, `SCRAPER_DATASET_TIMEOUT` to 3600, `SCRAPER_POLL_INTERVAL` to 10, `SCRAPER_MIN_USABLE_TEXT_LENGTH` to 200, `SCRAPER_HEAL_MIN_FAILURES` to 2, `SCRAPER_MAX_HEALS` to 1.
- `set-key` stores a per user credential in Postgres, but the matching environment variable wins when both exist (`src/lib/keys.ts`).
- The container image runs the same CLI: keys come from the environment, interactive commands (signup, login, set-key) need `docker run -it`, and the container reaches host Postgres via `host.docker.internal` (`--add-host=host.docker.internal:host-gateway` on Linux).
- `docker-compose.yml` runs the CLI with its own internal Postgres (no host port, named volume, healthcheck): `docker compose run --rm querybase <command>`. Keys come from `.env` via `env_file`, and the container's `DATABASE_URL` is derived from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` pointing at the stack's `postgres` service.
- **Rate limit**: token consumed after successful command (not before). Failed commands don't cost a token.
- **Index advisory lock**: `pg_try_advisory_xact_lock` prevents concurrent index runs per source.
- **Crawl transaction**: page saves wrapped in `store.withTransaction()` for atomicity.
- **Credentials**: merged into `keys.ts` (single source of truth for env vars, rotation logic).

## Agent skills

- [multi-stage-dockerfile](.agents/skills/multi-stage-dockerfile/): `github/awesome-copilot`, Docker multi stage builds, layer caching, base image choice, hardening
- [docker-development](.agents/skills/docker-development/): `netresearch/docker-development-skill`, Dockerfile best practices, Compose, CI image testing
- [github-actions](.agents/skills/github-actions/): `callstackincubator/agent-skills`, GitHub Actions workflows
- [github-actions-templates](.agents/skills/github-actions-templates/): `wshobson/agents`, production GitHub Actions workflow templates including Docker build and push to a registry
- MCP servers: github-mcp-server (recommended)