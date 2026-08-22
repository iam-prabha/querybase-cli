# 0006. Self contained docker stack

**Date**: 2026-08-19
**Status**: Accepted

## Summary

This spec adds a self contained production stack so the CLI container brings its own Postgres and never depends on the local Postgres on port 5433. A separate `docker-compose.prod.yml` starts the CLI and its own Postgres together on one compose network, keys come from `.env`, and state persists in a named volume and in Qdrant cloud. One command runs any CLI command, which is the friendliest shape for people and agents consuming the tool.

## Context

The current container image is only the CLI. To run it you must already have a Postgres reachable, and today that means the local docker compose Postgres on port 5433. That hidden dependency is friction for anyone pulling the image, especially an AI agent that expects a tool to work from env vars and one command. If the local Postgres is down, the container CLI fails.

The fix is not to bake Postgres into the CLI image (a multi process container is an anti pattern) but to bundle it as a sibling service in its own compose file. The existing `docker-compose.yml` stays as the local dev Postgres; the new file is the self contained deliverable. This follows the proven pattern of an app plus its database as one compose unit.

Not deciding keeps the image half usable: published on GHCR but dependent on a host database that the docs then have to wire up by hand.

## Requirements

**User stories**:
- As a person or agent pulling the image, I want to run any CLI command with one compose command and no database setup, so the tool just works.
- As the engineer, I want the stack to keep its own database separate from my local dev Postgres, so the two never interfere.
- As the engineer, I want keys to come from the existing `.env`, so secrets never sit in the compose file.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: `docker compose -f docker-compose.prod.yml run --rm querybase <command>` runs any CLI command with the local Postgres stopped, using the stack's own Postgres.
- **AC-2**: The stack Postgres is internal (no host port), data persists in a named volume, and state survives across runs.
- **AC-3**: Keys come from `.env`; the container's `DATABASE_URL` points at the `postgres` service, never at a host address.
- **AC-4**: No product code changes; only the compose file, README, and an AGENTS.md fact.
- **AC-5**: The local dev Postgres on port 5433 and the local CLI workflow stay untouched.
- **AC-6**: The GHCR image path is `ghcr.io/iam-prabha/querybase`, matching the repo owner account, so the stack can reference a published image.

## Options considered

### Option 1: Separate compose file with an internal Postgres

A new `docker-compose.prod.yml` with two services: `postgres` (internal, named volume, healthcheck) and `querybase` (the CLI image, `depends_on` the healthy Postgres, keys from `.env`).

**Pros**:
- Fully self contained; the local dev Postgres is untouched.
- One command to run the CLI; compose auto starts Postgres first.
- No host port, so no clash with the dev Postgres on 5433.
- The proven app plus database compose pattern.

**Cons**:
- A second compose file to know about and document.
- The Postgres password sits inside the `DATABASE_URL`, so special characters must be URL safe.

### Option 2: Add the CLI service to the existing docker-compose.yml

One compose file with both Postgres and the CLI.

**Pros**:
- One file, one mental model.

**Cons**:
- The prod CLI would share the dev database on 5433, so "does not depend on local Postgres" only half holds.
- The CLI runs a command and exits, so `docker compose up` starts a container that immediately stops; the file is awkward for its main use.

### Option 3: Hosted Postgres

Point the image at a cloud Postgres service (like Neon or Supabase) via `DATABASE_URL`.

**Pros**:
- The image itself stays database agnostic and the database is reachable from anywhere.

**Cons**:
- Still an external dependency the consumer must provision and pay for; less self contained than bundling.
- Does not remove setup work, it moves it to a third party signup.

## Decision

**Chosen option**: Option 1: Separate compose file with an internal Postgres

Add `docker-compose.prod.yml` with an internal `postgres` service and a `querybase` service, keys from `.env`, and the GHCR namespace fixed to `ghcr.io/iam-prabha/querybase`. The existing dev compose file is unchanged.

**Implementation skills**: `docker-development` (`netresearch/docker-development-skill`, `.agents/skills/docker-development/`) · `multi-stage-dockerfile` (`github/awesome-copilot`, `.agents/skills/multi-stage-dockerfile/`) for the container build and compose conventions

## Rationale

The separate file keeps the two worlds apart: the dev Postgres on 5433 stays a local workflow, and the prod stack is a clean deliverable. Bundling Postgres as a sibling service removes the host database dependency without the anti pattern of a multi process image. This is the shape an agent prefers: one command, env vars, no hidden infrastructure. Hosted Postgres would keep the setup burden on the consumer, and extending the dev file couples state the two setups must not share.

## Feature design

**Data model sketch**: none. The stack reuses the existing Postgres schema, Qdrant collection, and `.env` keys unchanged.

**State transitions**: not applicable. No new state machine.

**API surface**: no new product surface. The stack surface is the compose file and its usage.

| Compose service | Purpose |
|---|---|
| `postgres` | the stack's own Postgres, internal, data in the named volume |
| `querybase` | the CLI container, entrypoint `node dist/index.js`, runs on demand via `docker compose run` |

**Value sourcing** (every value the stack needs, and where it comes from):

| Value | Source |
|---|---|
| `DATABASE_URL` inside the container | derived in the compose file: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}` |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `.env`, same values the dev stack already uses |
| all other keys (`BRIGHTDATA_API_KEY`, `QDRANT_URL`, `EMBEDDING_API_KEY`, and so on) | `.env` via `env_file` |
| the image the CLI runs | the local build, tagged `ghcr.io/iam-prabha/querybase:latest` |

**Key invariants**:
- The compose `environment` block overrides `DATABASE_URL` so the container never uses the host address from `.env`.
- The stack Postgres exposes no host port.
- Data persists in the named volume, and Qdrant cloud keeps the vectors, so reindexing is not needed between runs.
- The dev compose file and the local CLI workflow are not modified.

**Security model**:
- `crawl` and `ask` still require an authenticated user, unchanged.
- All keys live in `.env`, which is gitignored; the compose file contains no secret values, only variable references.
- The stack Postgres is internal to the compose network, reachable only by the CLI container.

**Configuration required**:
- No new environment variables. The stack reads the existing `.env`. `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` must already be set, and the password must be URL safe since it is embedded in `DATABASE_URL`.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: local Postgres stopped, `docker compose -f docker-compose.prod.yml run --rm querybase --version` prints the version and a DB touching command connects to the stack Postgres, verifies **AC-1**
- State: run a command, stop the stack, run again, and confirm the data is still there from the volume, verifies **AC-2**
- Isolation: the local dev Postgres on 5433 still starts and the local CLI still works after the stack has been used, verifies **AC-5**
- Image path: `publish.yml` tags use `ghcr.io/iam-prabha/querybase`, verifies **AC-6**

## Build plan

1. [ ] Fix the GHCR namespace in `.github/workflows/publish.yml` from `velprabhakaran` to `iam-prabha` for both tags, satisfies **AC-6**
2. [ ] Add `docker-compose.prod.yml`: internal `postgres` with a named volume and healthcheck, and a `querybase` service with `build: .`, the GHCR tag, `depends_on` the healthy Postgres, `env_file: .env`, and the derived `DATABASE_URL`, satisfies **AC-1**, **AC-2**, **AC-3**
3. [ ] Add a README section for the self contained stack: the one command usage, the `-it` note for interactive commands, and the URL safe password note, satisfies **AC-3**, **AC-5**
4. [ ] Verify with the local Postgres stopped: build the image, run `--version`, then a DB touching command against the stack Postgres, and confirm the dev stack on 5433 still works afterward, satisfies **AC-1**, **AC-2**, **AC-5**

## Consequences

**Positive**:
- The container image becomes usable by anyone with Docker, including agents, without a separate database.
- The local dev workflow is untouched.
- One command to run the CLI against a persistent database.

**Negative / tradeoffs**:
- A second compose file to maintain and document.
- The password is embedded in the derived `DATABASE_URL`, so it must be URL safe.
- The image build is a local step until the GHCR image is published; the compose file references the GHCR tag so the local build can be dropped once published.

**Neutral**:
- The stack still needs the external services (Qdrant cloud, Bright Data, NVIDIA) and their keys; only the database is bundled.
- Interactive commands (signup, login, set-key) need `-it` under compose.

## Follow-up

- [ ] The new compose file belongs in root `AGENTS.md` (structure line and a fact for `docker-compose.prod.yml`); flagged for /sync
- [ ] The `docker-development` and `multi-stage-dockerfile` skill conventions are already recorded in root `AGENTS.md` from spec 0004; no further action
