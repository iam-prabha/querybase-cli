# 0004. Docker and registry deployment

**Date**: 2026-08-19
**Status**: Accepted

## Summary

Package the querybase CLI as a Docker image and publish it to the GitHub Container Registry (GHCR). A multi stage build on the node 22 alpine base produces a small runtime image that runs every command through the existing `querybase` binary. A GitHub Actions workflow builds and pushes the image whenever a version tag such as `v0.1.0` is pushed. Anyone can then run the tool with `docker run ghcr.io/velprabhakaran/querybase <command>` without installing Node, linking the CLI, or building from source.

## Context

querybase is a personal CLI. To run it today you need Node 22+, `npm install`, and a build, then `npm link` or `npm run dev`. That is fine on a developer machine but it is a barrier for anyone who just wants to run the tool, and it makes the tool hard to show as a deployable product. The project is being prepared for a public GitHub push and a contest entry, where a container image is a concrete, reproducible way to run the tool.

The CLI is stateless: pages, accounts, and meta live in Postgres, vectors live in Qdrant cloud, and every key comes from the environment. There is no local file state. So a container is simply the compiled `dist/` plus the production dependencies, and the existing environment variable configuration carries straight across.

Two facts shape the image design. First, the build tools (typescript and tsx) currently sit in `dependencies`, not `devDependencies`, even though they are only needed to build and run the dev server. A runtime image that installs production dependencies would still carry them, bloating the image. They belong in `devDependencies`. Second, Postgres already runs on the host through docker compose on port 5433, and a container cannot reach the host's `localhost`, so running the CLI in a container needs the host gateway address or the compose network. That is a documentation concern, not a code concern.

## Requirements

**User stories**:
- As a user, I want to run `docker run ghcr.io/velprabhakaran/querybase ask "question"` so I can use querybase without installing Node or building from source.
- As a maintainer, I want the image built and pushed automatically when I push a version tag, so the registry stays current without manual steps.

**Acceptance criteria** (each criterion is IDed and independently checkable):
- **AC-1**: A `docker build` from the repo root produces an image whose entrypoint is the `querybase` CLI, so `docker run <image> status` runs and reports the current source and configuration.
- **AC-2**: The runtime image contains only production dependencies; typescript, tsx, vitest, and the test sources are absent from it.
- **AC-3**: The image supports every command. Non interactive commands run with `docker run`, and interactive ones (`signup`, `login`, `set-key`) work with `docker run -it`.
- **AC-4**: A GitHub Actions workflow builds the image and pushes it to `ghcr.io/velprabhakaran/querybase` on version tag pushes (`v*`), tagging both the version and `latest`, using only the repository's built in token with no stored secrets.
- **AC-5**: No secrets enter the image build context: `.env` and local state files are excluded by `.dockerignore`.
- **AC-6**: `npm test`, `npx tsc --noEmit`, and `npm run build` all still pass after moving typescript and tsx to `devDependencies`.

## Options considered

### Option 1: Keep the npm linked CLI as the only distribution

The current path: clone, `npm install`, `npm run build`, `npm link`.

**Pros**:
- Nothing to build or maintain beyond the repo.

**Cons**:
- Every user needs the Node toolchain and a build. No deployable, reproducible unit to run or share.

### Option 2: A container image published to the GitHub Container Registry

**Pros**:
- One `docker run` command to use the tool, no install steps.
- Reproducible: the image is built the same way every time and tagged by version.
- GHCR authentication uses the repository's built in token, scoped to just the packages write permission, so no stored credentials live in the workflow.
- Images can stay private if ever needed, and they pair naturally with a GitHub push.

**Cons**:
- A Dockerfile, a `.dockerignore`, and a workflow to maintain.
- The container must reach the host's Postgres, which needs a documented network detail (`localhost` inside a container is not the host).

### Option 3: A container image published to Docker Hub

**Pros**:
- The most familiar public registry.

**Cons**:
- Publishing automation typically needs a stored access token in the workflow.
- Private images are paid, and there is no security or integration gain over GHCR for a public image.

## Decision

**Chosen option**: Option 2: a container image published to the GitHub Container Registry.

The runtime image is built multi stage on `node:22-alpine`. The build stage installs all dependencies and compiles `src` to `dist`. The runtime stage installs only production dependencies, copies `dist/`, and runs the CLI as its entrypoint, so every command works, interactive ones with `docker run -it`. Typescript and tsx move to `devDependencies` so the runtime layer stays lean. A GitHub Actions workflow builds and pushes the image on version tag pushes. Postgres reachability from the container is documented in the README.

## Rationale

GHCR is the more secure and cleaner registry for this project. The action authenticates with the built in repository token, which carries only the packages write scope it needs, so no personal access token or password is stored in the workflow, and the account can keep images private at no cost. The multi stage build keeps the published image small because the runtime stage installs only what `dist/index.js` needs at runtime; typescript and tsx are build and dev tools, not runtime needs, which is why they move to `devDependencies`. Triggering on version tags keeps every pushed image reproducible and named by a version instead of publishing on every commit. Keeping the full CLI in the container preserves the existing workflow; only the interactive prompts need a terminal, which `docker run -it` provides. Alpine is safe here because all runtime dependencies are pure JavaScript, with no native compilation.

## Feature design

**Artifacts**:

| Artifact | Path | Purpose |
|---|---|---|
| Dockerfile | `Dockerfile` | multi stage image build |
| Build context exclusions | `.dockerignore` | keep secrets and local build artifacts out of the image |
| CI workflow | `.github/workflows/publish.yml` | build and push on version tags |
| Usage docs | `README.md` | build, pull, and run examples |

**Image contract**:
- Base: `node:22-alpine` for both stages.
- Workdir: `/app`.
- Entrypoint: `["node", "dist/index.js"]`, so `docker run <image> ask "..."` behaves like `querybase ask "..."`.
- Runtime dependencies: the `dependencies` group only, installed with `npm ci --omit=dev`.
- Configuration: all keys come from environment variables, passed with `docker run -e ...` or an env file, the same variables documented in `.env.example`.

**Value sourcing** (every value the build produces names where it comes from):

| Value produced | Source |
|---|---|
| runtime node_modules | `npm ci --omit=dev` against `package.json` dependencies |
| compiled CLI | `npm run build` (`tsc -p tsconfig.json`) over `src/` |
| image entrypoint | the `bin` field in `package.json` (`dist/index.js`) |
| image name and tags | the repository owner and the pushed tag name in the workflow |
| push credentials | the built in `GITHUB_TOKEN` with packages write scope |

**Security model**: no secrets are stored in the repo or the workflow. `.env`, git files, local databases, and test sources are excluded from the build context. The image reads keys only from environment variables at run time.

**Configuration required**: none at runtime beyond the existing environment variables.

**Critical test scenarios**:
- Build: `docker build -t querybase:local .` succeeds, then `docker run querybase:local status` reports the source, verifies **AC-1**.
- Size: confirm the runtime stage installs production dependencies only, no typescript, tsx, or vitest files in the image, verifies **AC-2**.
- Interactive: `docker run -it querybase:local whoami` runs and prompts where a prompt is needed, verifies **AC-3**.
- CI: pushing a `v*` tag triggers the workflow, which pushes the version and `latest` tags, verifies **AC-4**.
- Context: `.env` and local state are listed in `.dockerignore` and never appear in the image, verifies **AC-5**.
- Regression: `npm test`, `npx tsc --noEmit`, and `npm run build` pass after the dependency move, verifies **AC-6**.

## Build plan

1. Move `typescript` and `tsx` from `dependencies` to `devDependencies` in `package.json`, then run `npm install` to refresh the lockfile, satisfies **AC-6**
2. Write the multi stage `Dockerfile`: the build stage installs all dependencies and compiles `src`, the runtime stage installs production dependencies only and copies `dist/`, with the CLI as the entrypoint, satisfies **AC-1**, **AC-2**
3. Write `.dockerignore` excluding `node_modules`, `dist`, `.env`, `tests`, `docs`, the agent folders, and git files, satisfies **AC-5**
4. Write `.github/workflows/publish.yml`: on `v*` tag pushes, build and push to `ghcr.io/velprabhakaran/querybase` tagged with the version and `latest`, authenticated with the built in token, satisfies **AC-4**
5. Add a Docker usage section to `README.md`: build locally, pull from the registry, run examples for every command, `-it` for interactive commands, and how the container reaches the host Postgres, satisfies **AC-3**
6. Verify: `npm test`, `npx tsc --noEmit`, `npm run build`, then a local `docker build` and `docker run ... status`, satisfies **AC-1**, **AC-6**

## Consequences

**Positive**:
- Anyone can run querybase with a single `docker run` command, no Node install and no build.
- The registry carries versioned, reproducible images that stay current with tag pushes.
- No secrets or stored credentials anywhere in the build or push path.

**Negative / tradeoffs**:
- A second distribution path to maintain alongside the npm linked CLI.
- The container must reach Postgres on the host through the host gateway or the compose network, a documented operational detail.
- Interactive account commands need a terminal, so they expect `docker run -it`.

**Neutral**:
- The image does not include local data; Postgres and Qdrant stay the source of truth.
- Publishing to npm later is unaffected; the `prepublishOnly` build already exists.

## Follow-up

- [ ] Enroll a matching scope feature for deployment (none exists today) so the work is tracked in the scope.
- [ ] On the first public tag push, confirm the GHCR package visibility matches the repo (public for an open repo).
- [ ] When the workflow tier rises above Prototype, verify this feature with `/check verify`; at Prototype the develop self check closes it.