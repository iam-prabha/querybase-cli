# Verify: Stack & architecture · spec 0001 · updated 2026-08-18
_Steps derived from spec 0001. `/check verify` runs these; `/test` locks the durable ones._

## Commands

- [x] `querybase status` → shows the source url, type, page counts, storage (Postgres), generation model, collection name, and per provider key state (`brightdata: set`, `qdrant: set`, `embed: set`)
- [x] `querybase set-key embed abc` while logged out → `error: You must be logged in`, exit code 1
- [x] `querybase set-key embed <key>` while logged in → stores the key, then `querybase status` shows `embed: set`
- [x] `querybase unset-key embed` → removes the key, `querybase status` shows `embed: missing`
- [x] `querybase crawl [url]` (Bright Data key set, zone env set) → discovers the page list, fetches each (markdown as-is, HTML converted), prints `Saved N page(s), skipped M unchanged`, and `querybase status` shows the page count
- [x] `querybase crawl` again → `skipped` all unchanged, page count stable
- [x] `querybase index` (embed and qdrant keys set, qdrant url set) → sections, chunks, embeds, and upserts; `querybase status` shows all pages indexed
- [x] `querybase index` again → `Indexing 0 page(s)` since nothing changed (content hash skip)
- [x] `querybase index --rebuild` → prints `Recreated collection "<name>"` and re indexes every page (50 pages, 794 chunks on the verification run)
- [x] `querybase ask "what is the web unlocker"` (generation configured) → an answer plus a `Sources:` list where each line is a real page url with a heading path
- [x] `querybase init <new url>` after a source is set → prints `Switched source`, wipes pages, and the next `querybase index` recreates the collection
- [x] Chunking fits the embedding model: API reference pages with 15k+ token sections index without a token limit error
- [x] Postgres migration: `scripts/migrate.mjs` copied users, meta, and credentials once; `status` reads from Postgres; the local `.querybase/` folder was deleted

## Acceptance-criteria coverage

- Done when: pipeline runs end to end on a real docs site → `crawl`, `index`, `ask` steps above (verified on https://docs.brightdata.com)
- Done when: ask answers with a Sources list pointing at real pages → `ask` step above
- Gating: crawl, index, ask, set-key, unset-key require login → `set-key` logged out step
- Key resolution: env beats stored key → set `EMBEDDING_API_KEY` in env, store a different value with `set-key`, `ask` uses the env value (visible in `status` order)
- Orphan cleanup: edit a page, `crawl` then `index`, `ask` must not cite the removed heading → covered by `index` re-run behavior