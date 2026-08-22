# Scope: Querybase

A command line tool that turns any documentation website into a searchable knowledge base you can ask questions of, with every answer citing the real page and heading it came from.

**Build approach:** Tracer Bullet (an end to end slice of the pipeline from crawl to ask, learned feature by feature).
**Workflow:** Prototype (develop builds and self checks; nothing extra runs after it, and no feature needs to be a full production product).

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use /develop and skip /architect. You decide when a feature is done._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Stack & architecture | Foundation | done |
| 2 | Structured ask output | Feature | done |
| 3 | Scraper Studio fetch | Feature | done |
| 4 | Docker deployment and registry | Deployment | done |
| 5 | Self contained docker stack | Deployment | done |

## Foundation

### 1. Stack & architecture · done
The stack and the end to end pipeline that runs on it: fetch pages raw through the Bright Data SDK (markdown sources used as-is, HTML converted with turndown), split them into sections, chunk sections to fit the embedding model, embed through NVIDIA NIM (`nvidia/nv-embedqa-e5-v5`), store the vectors in Qdrant cloud, keep accounts and pages in Postgres, and answer questions with citations through any OpenAI compatible chat endpoint (NVIDIA NIM by default).
**Done when:** the pipeline runs end to end on a real docs site and ask answers with a Sources list that points at real pages.
- [x] Decide the stack (spec): `/architect stack & architecture`
- [x] Scaffold from the decision: `/develop stack & architecture`
- [x] Verify end to end: `crawl` → `index` → `ask` against https://docs.brightdata.com, 50 pages indexed
Spec [0001](../specs/0001-querybase-architecture/index.md) · code in `src/`

### 2. Structured ask output · done
A `--json` flag on `ask` so an agent or script can read the answer and its cited sources as one machine readable document on stdout, while the console format and error behavior stay unchanged.
**Done when:** `querybase ask --json "<question>"` prints one JSON document with the answer and sources, and the plain format plus stderr errors with exit code 1 are unchanged.
- [x] Decide the surface (spec): `/architect structured ask output`
- [x] Build it: `/develop structured ask output`
  - [x] Add the `--json` flag and JSON output branch in `src/commands/ask.ts` (AC-1, AC-2, AC-3)
  - [x] Update `README.md` with the flag and the stderr error note (AC-2)
  - [x] Typecheck, build, and self check the JSON document with `JSON.parse` (AC-4)
Spec [0002](../specs/0002-structured-ask-output.md) · code in `src/commands/ask.ts`

### 3. Scraper Studio fetch · done
Make Scraper Studio the primary page fetch engine: generate a collector per source on its first crawl, rerun it in one batch per crawl, self heal empty extractions, and keep the SDK as a fallback for pages that still fail after healing.
**Done when:** crawl fetches through a per source Scraper Studio collector, empty extractions self heal with a per crawl cap, pages that still fail fall back to the SDK before being skipped, and ask still answers with a Sources list.
- [x] Design the fetch engine (spec): `/architect scraper studio fetch`
- [x] Build it: `/develop scraper studio fetch`
  - [x] Build the Scraper Studio client: ensure collector, one batch trigger, markdown mapper, heal flow (AC-1, AC-2, AC-4)
  - [x] Wire crawl with the SDK fallback split and progress notes (AC-1, AC-3, AC-5, AC-6, AC-7)
  - [x] Self healing floor, cap, and retry policy; live probe of the dataset row shape (AC-2, AC-4)
  - [x] Unit tests, the suite, and a small end to end crawl that answers a question (AC-8)
Spec [0003](../specs/0003-scraper-studio-fetch/index.md) · code in `src/lib/`

## Deployment

### 4. Docker deployment and registry · done
Package the CLI as a container image on Docker Hub: a multi stage build, an on tag publish workflow, and documented docker usage so anyone can run the tool without installing Node or building from source.
**Done when:** `docker build` produces a working image, `docker run <image> <command>` runs every CLI command, and a version tag push publishes the image to Docker Hub.
- [x] Design the deployment (spec): `/architect docker deployment`
- [x] Build it: `/develop docker deployment`
  - [x] Multi stage Dockerfile and .dockerignore (AC-1, AC-2, AC-5)
  - [x] Dependency split: typescript and tsx moved to devDependencies (AC-6)
  - [x] CI workflow on version tags with Docker Hub push (AC-4)
  - [x] README Docker usage and host Postgres notes (AC-3)
  - [x] Local docker build and run verification (AC-1, AC-6)
Spec [0004](../specs/0004-docker-registry-deployment.md) · code in `Dockerfile`, `.github/workflows/publish.yml`, `.dockerignore`

### 5. Self contained docker stack · done
Bundle the CLI with its own Postgres into one self contained compose stack, so anyone pulling the Docker Hub image can run every command with one compose command and no host database.
**Done when:** `docker compose run --rm querybase <command>` runs with the local Postgres stopped, and the local dev workflow on port 5433 is untouched.
- [x] Design the stack (spec): `/architect self contained docker stack`
- [x] Build it: `/develop self contained docker stack`
  - [x] Fix the Docker Hub namespace in publish.yml to `iamprabha010` (AC-6)
  - [x] Update `docker-compose.yml` with an internal Postgres and a derived DATABASE_URL (AC-1, AC-2, AC-3)
  - [x] README section for the self contained stack (AC-3, AC-5)
  - [x] Verify with the local Postgres stopped and re check the dev stack (AC-1, AC-2, AC-5)
Spec [0006](../specs/0006-self-contained-docker-stack.md) · code in `docker-compose.yml`, `.github/workflows/publish.yml`

## Legend

**The decision box.** Every feature carries exactly one, the sub task whose label ends with `(spec)`. Skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Next step** = the first unticked box. **needs a decision** = run `/architect` first; otherwise straight to `/develop`. **Status** `planned` → `in-progress` → `done`, plus `existing` (pre-workflow) and `dropped` (de-scoped, kept for history).