# 0001. Querybase architecture: decision record

**Date**: 2026-08-17
**Status**: Accepted

## Context

A documentation website is a pile of linked pages written for humans. Answering a question about a product means opening several pages, reading, and trusting what you find. querybase wants to collapse that into one command: you ask, it retrieves the exact sections that matter, and an LLM writes an answer that points back to the real pages.

The constraints that shaped the stack:

- You already have a working foundation: Node and TypeScript, a commander CLI, scrypt auth, and a store. The architecture must extend it, not replace it.
- The tool must be cheap. You run a personal tool, not a service, so the free tiers matter.
- You hold an NVIDIA NIM key. NVIDIA serves both embeddings (nv-embedqa-e5-v5) and chat (llama-3.3-nemotron-super-49b-v1) on its free tier, one key for both.
- The docs live on the public web. Some sites, like Bright Data's, render in JS, so a plain HTTP fetch can miss content.
- Everything runs on your machine as a CLI. No server to deploy, no team to coordinate with.
- Citations must be real: the retrieved section and the page url it came from.

## Options considered

**Stack A. SDK fetch, OpenAI embeddings, local SQLite vectors, Ollama generation.**
Fetch pages with the Bright Data SDK, embed with OpenAI text-embedding-3-small at about two cents per million tokens, store vectors in the same SQLite database with a flat cosine search, and generate locally with Ollama.
Pros: only one data store, no cloud dependency for retrieval, no vector server to learn.
Cons: retrieval is a brute force scan, which limits quality as the index grows; local models are weaker for grounded writing; Ollama is another runtime to install; flat search means no real ranking features.

**Stack B. SDK fetch, custom OpenAI compatible embeddings, Qdrant cloud, OpenAI compatible chat, Postgres store. (chosen)**
Fetch pages raw with the Bright Data SDK (markdown as-is, HTML via turndown), embed with any OpenAI compatible endpoint you point it at (NVIDIA NIM by default), store vectors in Qdrant cloud on the free tier, generate with an OpenAI compatible chat endpoint (NVIDIA NIM by default), and keep accounts and pages in a Postgres docker container.
Pros: real vector search with production ranking, generation and embeddings free on NVIDIA, the embedder and chat provider stay pluggable, Postgres is a proper database instead of a file, and it exercises the exact skills installed for Bright Data and Qdrant.
Cons: a hosted service to trust and pay attention to, plaintext keys in a local database, a docker dependency for the store, and you must choose an embedding provider separately from the chat provider.

**Stack C. Plain HTTP fetch, local MiniLM embeddings, JSONL files.**
Fetch pages with node fetch, parse with cheerio, embed with a local MiniLM model, and keep vectors in a JSONL file.
Pros: no cloud at all, no API keys, fully offline.
Cons: JS rendered sites come back half empty, no real search index, embedding a local model in a CLI is fiddly, and citations are weaker because headings survive poorly.

**Stack D. Full hosted pipeline.**
A server that ingests, an embedding service, a managed vector database, and a cloud generation API, all wired through an MCP server.
Pros: the most production like and the most scalable.
Cons: far more than a personal CLI needs; you would operate a server to get the same result one command gives today.

## Rationale

The decision balances your stated preferences with the hard facts of the current tooling.

- You asked for the Bright Data SDK for every fetch. It is the reliable way to get pages from JS rendered sites, and it is what the Bright Data docs recommend. Plain fetch only handles llms.txt and sitemap.xml, which are machine oriented by design. Raw format is requested so markdown sources are preserved verbatim instead of being re converted into a blockquote by the SDK's markdown formatter; HTML pages are converted locally with turndown.
- You asked for Qdrant over SQLite for vectors. Qdrant cloud on the free tier gives real ANN search with a proper client, which is exactly the qdrant skills you installed. It costs nothing for a personal index.
- You chose NVIDIA NIM for generation and embeddings because you already hold the key and the free tier serves both. The generation layer is an adapter over any OpenAI compatible chat endpoint, so you can point it at another provider if you ever want to.
- NVIDIA NIM cannot be assumed to fit arbitrary input, so sections are chunked to a token budget before embedding, and the embedder splits recursively when a chunk still overflows. This keeps any model and any content density working.
- The chat provider does not serve embeddings, so the embedding layer is an adapter. Any OpenAI compatible endpoint works, and the configuration lives in env. This keeps you unblocked no matter which embedding provider you pick.
- You chose Postgres over the original SQLite store. A dedicated docker container (postgres:16) keeps accounts, pages, and meta in a real database, and the old SQLite file was migrated once and removed.
- Local accounts and per user keys reuse the auth already built, and environment variables take precedence so a key on the machine beats a key in the file.
- Everything else (remark sectioning, vitest) follows the existing codebase and the zero native dependency goal.

The one honest cost is that two stores now exist: Postgres for accounts and pages, Qdrant for vectors. That is the price of real vector search, and it is small.

## References

**Project sources**
- Existing CLI and data layer: package.json, tsconfig.json, src/index.ts, src/types.ts, src/lib/store.ts, src/lib/source.ts, src/lib/auth.ts, src/commands/
- Bright Data agent skills: `.agents/skills/brightdata-sdk/`, `.agents/skills/brightdata-sdk-js/`
- Qdrant agent skills: `.agents/skills/qdrant-clients-sdk/`, `.agents/skills/qdrant-deployment-options/`

**Practices and standards**
- OWASP password storage guidance: scrypt with per user salt (basis: OWASP cheat sheet)
- llms.txt as the machine readable entry point for docs (basis: Bright Data ships it)
- ANN retrieval over brute force for growth and ranking (basis: Qdrant is purpose built for this)

**Links**
- https://docs.brightdata.com/llms.txt
- https://docs.brightdata.com/api-reference/SDK-JS.md
- https://integrate.api.nvidia.com
- https://www.postgresql.org
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-4o-mini
- https://docs.x.ai/developers/models
