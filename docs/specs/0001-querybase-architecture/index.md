# 0001. Querybase architecture: docs to RAG with citations

**Date**: 2026-08-18
**Status**: Accepted

## Summary

querybase is a command line tool that turns a documentation website into a searchable knowledge base you can ask questions of. It fetches each page through the Bright Data SDK, splits the markdown into sections, embeds each section as a vector, stores the vectors in Qdrant cloud, and answers questions by retrieving the closest sections and having a chat model write the reply with source links. Accounts and pages live in Postgres. This spec records the full stack and the reasoning behind each choice.

## Decision

Adopt the stack below. In short: Node and TypeScript, a commander based CLI, page fetch through the Bright Data SDK, remark based sectioning, embeddings from any OpenAI compatible endpoint you configure, free generation on an OpenAI compatible chat endpoint, vectors in Qdrant cloud, accounts and pages in Postgres, local accounts with per user keys, and vitest for tests. (basis: your Bright Data SDK preference; your Qdrant and NVIDIA NIM choices; your Postgres preference)

**Implementation skills**: `brightdata-sdk` (`brightdata/skills`, `.agents/skills/brightdata-sdk/`) · `brightdata-sdk-js` (`brightdata/skills`, `.agents/skills/brightdata-sdk-js/`) · `qdrant-clients-sdk` (`qdrant/skills`, `.agents/skills/qdrant-clients-sdk/`) · `qdrant-deployment-options` (`qdrant/skills`, `.agents/skills/qdrant-deployment-options/`)

## Proposed stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript on Node 26, ESM | Already in use; fetch is native, process.loadEnvFile loads .env, and the project direction is TypeScript |
| CLI framework | commander | Already in use; small, standard, easy to extend with new subcommands |
| Index discovery | llms.txt first, sitemap.xml fallback, fetched over plain HTTPS | These files are machine oriented, so plain fetch is free and reliable; Bright Data documents llms.txt as the entry point (basis: https://docs.brightdata.com/llms.txt) |
| Page fetch | Bright Data SDK (@brightdata/sdk), scrapeUrl raw | Raw fetch keeps source fidelity; markdown served by docs sites (llms.txt .md pages) is used as-is, and HTML pages are converted with turndown. Handles anti bot and JS rendering (basis: https://docs.brightdata.com/api-reference/SDK-JS.md) |
| Sectioning | remark (remark-parse AST) | A mature markdown AST makes it easy to split on heading nodes and keep code blocks whole; one dependency |
| Chunking | character budget split in lib/chunk.ts | Sections can exceed an embedding model's token limit (NVIDIA e5-v5 caps at 512 tokens), so sections are split on paragraph boundaries within a token budget, with an adaptive split as a safety net in the embedder |
| Embeddings | Any OpenAI compatible endpoint, configurable base URL, model, and dimensions; default NVIDIA NIM nvidia/nv-embedqa-e5-v5, 1024 dims | NVIDIA NIM is free and needs no extra account beyond the nvapi key; the embedder is an adapter you point at any provider that serves embeddings |
| Generation | Any OpenAI compatible chat endpoint via GENERATION_BASE_URL; default NVIDIA NIM nvidia/llama-3.3-nemotron-super-49b-v1, overridable to another endpoint | One OpenAI compatible client pattern; the NVIDIA key doubles as the chat key (basis: https://integrate.api.nvidia.com) |
| Vector store | Qdrant cloud free tier via @qdrant/js-client-rest | Your choice; cloud removes a local server process and the free tier fits a personal tool |
| Local persistence | Postgres via pg in a dedicated docker container (docker-compose.yml, port 5433) | Your choice; a real database keeps accounts, pages, and meta reliable and queryable (basis: https://www.postgresql.org) |
| Auth | Local accounts, scrypt hashed passwords, sessions stored in Postgres | Already built; passwords never stored in plaintext (basis: OWASP password storage guidance) |
| Secrets | Per user keys in the Postgres store, environment variables take precedence | Fits the accounts model and the one client pattern; plaintext in a local database is acceptable for a personal CLI, see Consequences |
| Tests | vitest | TypeScript native, fast, good watch mode |
| Observability | Simple console output | A CLI needs progress and errors, not a logging framework |

## Pipeline and data model

The pipeline has six stages: discover, fetch, section, embed, store, and ask. Discovery reads the page list. Fetch pulls each page raw through the SDK (markdown as-is, HTML converted with turndown). Sectioning splits a page on h1 and h2 headings into sections that keep their heading path, and text before the first heading attaches to the first section. Chunking splits long sections to fit the embedding model's token limit. Embedding turns each chunk into a vector. Storage puts vectors in Qdrant and pages in Postgres. Asking embeds the question, retrieves the closest sections, and generates a grounded answer.

**Postgres tables (database querybase)**
- meta(key TEXT PK, value TEXT): source url, source type, created at, current user, session token
- users(id SERIAL PK, username TEXT UNIQUE, password_hash TEXT, created_at TEXT)
- credentials(user_id INTEGER, provider TEXT, api_key TEXT, created_at TEXT, PK(user_id, provider))
- pages(url TEXT PK, title TEXT, markdown TEXT, content_hash TEXT, last_indexed_hash TEXT, fetched_at TEXT)

There is one active source at a time. Running init on a new url (or crawl with a url) switches the source, wipes the local pages table, and recreates the collection.

**Qdrant collection per index**
- One collection per source, shared across users, created on first index
- The collection name is a slug of the source host and path, using letters, digits, underscore, and hyphen, truncated to fit
- Each point holds the section vector plus a payload of section_id, page_url, heading_path, and text
- section_id is the sha256 of the page url plus the normalized heading path plus the chunk index
- A keyword payload index on page_url is created with the collection, because filtered deletes require one

**CLI surface**
- init <url>: detect the source type, save config to meta; on a new url this switches the active source and wipes the previous index
- signup, login, logout, whoami: local accounts
- set-key <provider> <key>, unset-key <provider>: providers are brightdata, qdrant, embed, requires login
- crawl [url]: discover pages (with an optional url to switch source first), fetch each through the SDK, store pages, skip unchanged content by hash
- index: section and chunk each page, embed each chunk, upsert to Qdrant; index --rebuild deletes and recreates the collection and re indexes every page
- ask "<question>": embed the question, retrieve the top 5 sections, prompt the chat model with numbered context, print the answer plus a Sources list of page url and heading path; the top k value is overridable through ASK_TOP_K
- status: page and section counts, generation model, embedding model, collection, and store location

**Value sourcing**
- The answer text comes from the generation call to the configured chat endpoint.
- Each citation in the Sources list comes from the retrieved Qdrant payload fields page_url and heading_path.
- The retrieval ranking comes from cosine distance in Qdrant between the embedded question and each section vector.
- The embedder configuration (base URL, model, dimensions) comes from env, never invented at runtime.
- The page list comes from llms.txt or sitemap.xml discovery at the exact root url given, with llms-full.txt tried when llms.txt is present, never from crawling links.
- The page title comes from the first h1 in the fetched markdown, falling back to the url basename.
- The content hash is sha256 over the normalized markdown, used to skip unchanged pages on crawl and index.

**Security model**
- crawl, index, ask, set-key, and unset-key require an authenticated user.
- Keys resolve from environment variables first, then the logged in user's stored key. Since environment keys beat stored keys, a second account on this machine uses the machine keys, not its own stored ones.
- Passwords are scrypt hashed with a fresh salt; session tokens are random 256 bit values.
- Qdrant traffic goes over TLS; access control is the Qdrant cloud API key.
- No regulated data is involved; the tool indexes public docs only.

**Configuration required**
- DATABASE_URL (plus POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB for the compose file): storage, the app connects with the url
- BRIGHTDATA_API_KEY and BRIGHTDATA_WEB_UNLOCKER_ZONE: page fetch, the key may also be set with set-key brightdata; the zone env names a pre created Web Unlocker zone, because the SDK cannot create one on a read only account
- GENERATION_BASE_URL and GENERATION_MODEL: generation; defaults to NVIDIA NIM, reusing the embedding key, overridable to any OpenAI compatible chat endpoint
- QDRANT_URL and QDRANT_API_KEY: vector storage, the key may also be set with set-key qdrant; the url is env only
- EMBEDDING_API_KEY, EMBEDDING_BASE_URL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS: embedding, the key may also be set with set-key embed, the rest is env only
- EMBEDDING_MAX_CHUNK_TOKENS: chunk budget for embedding, defaults to 480
- ASK_TOP_K: sections retrieved per question, defaults to 5
- The .env file is loaded with process.loadEnvFile, which Node provides, so no dotenv dependency

**Failure and edge handling**
- SDK fetches batch with a concurrency of about 5 and retry with backoff on rate limits.
- Embedding calls batch about 64 texts at a time and retry with backoff on server errors; client errors (4xx) are not retried.
- Sections are chunked to a token budget before embedding; if a chunk still exceeds the model's token limit, the embedder splits it in half recursively until it fits, so any model and any content density works.
- Both the chat model and the embedder are called over raw fetch against their OpenAI compatible REST endpoints, so no SDK dependency is needed for either.
- Sitemap loc tags are extracted with a small string scan, no XML dependency.
- crawl is resumable: unchanged pages are skipped by content hash.
- index re embeds only pages whose content hash differs from the stored last_indexed_hash, so repeated runs spend no credits on unchanged content; before re upserting a page, points whose page_url payload matches that page are deleted first, so removed sections cannot be cited. index --rebuild resets every page's last_indexed_hash and re indexes all of them.
- ask fails with a clear message if the index is empty, a key is missing, or the collection does not exist.
- MDX style tags are stripped defensively in case raw component tags survive into fetched markdown.
- The Postgres store is a docker compose service; the app fails fast with a clear connection error if the container is down.

## Consequences

**Positive**
- Any docs site is reachable, including JS rendered ones, because the SDK fetches and converts.
- Running is mostly free: NVIDIA NIM embeddings and chat, a cloud vector free tier, and Postgres locally.
- Citations carry real page urls and heading paths, so answers can be checked.
- Local accounts make the tool feel like a finished product.

**Negative / tradeoffs**
- Qdrant cloud is a hosted dependency; the tool stops working without network or if the cluster is deleted.
- Postgres and the docker daemon must be running for any command that touches the store.
- API keys sit in plaintext in a local database.
- Embedding quality depends on the endpoint you configure, there is no bundled default model.
- Bright Data page fetches spend credits, so a large crawl has a cost; the free tier is about 5000 credits a month.
- Two stores (Postgres and Qdrant) must stay in sync.

**Neutral**
- Switching the embedding model later means re embedding every chunk, and the vector size is fixed when the collection is created, so run index --rebuild to delete and recreate it first.
- NVIDIA NIM free tier rate limits apply to both embeddings and chat, so heavy runs may pause.

## Follow-up

- [x] Create the Qdrant cloud cluster and record its url and api key in .env.example
- [x] Pick a concrete embedding endpoint (NVIDIA NIM nvidia/nv-embedqa-e5-v5) and record it in .env.example
- [x] Migrate the local store from SQLite to Postgres (scripts/migrate.mjs, run once, .querybase deleted)
- [ ] Connect the chosen MCP servers in the agent config: Qdrant mcp-server-qdrant, Bright Data @brightdata/mcp
- [ ] Initialize a git repo, the project is not under version control yet
- [ ] Root AGENTS.md does not exist; it should record the stack conventions and the installed skills so later tasks load them (owned by /sync and /audit)

## Rationale

Reasoning and options: see rationale.md.
