# 0003. Scraper Studio as the page fetch engine

**Date**: 2026-08-19
**Status**: Accepted

## Summary

querybase currently pulls each page through the Bright Data SDK. This spec moves page fetching to Scraper Studio, Bright Data's AI built and self healing scraper platform, so the tool generates a custom scraper per documentation source and reruns it in batches. The scraper is built once per source and reused, and it fixes itself through Bright Data's self healing flow when a page comes back empty. The old SDK path stays behind as a fallback for pages that still fail after healing. Nothing downstream changes: sections, chunks, vectors, and answers all see the same markdown.

## Requirements

**User stories**:
- As a user, I want the first crawl of a source to generate a Scraper Studio collector for it and reuse it forever after, so the site fetch is tailored to the site and costs nothing to recreate.
- As a user, I want crawl to fetch every discovered page through the collector in batches, so one large site run becomes a few API calls instead of hundreds.
- As a user, I want pages whose extraction comes back empty to be fetched again through the collector's self healing flow, so a changed site does not silently drop content.
- As a user, I want the SDK fallback for pages that still fail after healing, so a stubborn page still gets one more chance before it is skipped with a warning.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: On the first crawl of a source with no collector, querybase creates a Scraper Studio collector through the REST API, polls the AI generation to done, and persists the collector id; later crawls reuse it without recreating.
- **AC-2**: Crawl fetches the discovered pages through one Scraper Studio batch run (a single trigger with all urls, polled to completion) and reassembles the extracted content into markdown so sectioning, chunking, embedding, and ask work unchanged.
- **AC-3**: Content hash skip survives: pages whose content is unchanged are not reindexed, and an interrupted crawl resumes where it left off. Every discovered page is fetched each crawl (as it is today), but unchanged pages skip sectioning, embedding, and upsert.
- **AC-4**: Self healing: pages whose extraction is empty or too short trigger a collector heal (refactor_template), auto approval, and a rerun of just those pages, capped per crawl; transient API failures retry with backoff.
- **AC-5**: A site with any number of pages completes through one batch trigger per crawl; the batch path has no realtime page limit, so no chunking or manual step is needed.
- **AC-6**: A page that still has no usable extraction after healing is retried through the existing SDK scrapeUrl path before it is skipped with a warning.
- **AC-7**: No new required environment variables; Scraper Studio authenticates with the existing `BRIGHTDATA_API_KEY`.
- **AC-8**: `npm test`, `npx tsc --noEmit`, and `npm run build` all pass, and a small end to end crawl through Scraper Studio still answers a question with a Sources list.

## Decision

**Chosen option**: Option 2: Replace with strangler, SDK kept as fallback

Adopt Scraper Studio as the primary page fetch engine, called direct from Node over the Bright Data REST API, with the existing SDK scrapeUrl path kept as a fallback for pages that still return no usable extraction after a heal. The collector is created once per source on its first crawl, stored in meta, and reused forever.

**Implementation skills**: `scraper-studio` (`brightdata/skills`, `.agents/skills/scraper-studio/`)

## Feature design

**Data model sketch**:
- `meta`: new key `scraper_collector_id` (TEXT, nullable). Stores the collector id for the current active source. One active source at a time, so one key is enough. Clearing the source (switch via init or crawl) clears it with the other source meta.
- `pages`: unchanged. The markdown produced by the collector feeds the same normalization and content hash as today.

**API surface** (all against `https://api.brightdata.com`, bearer `BRIGHTDATA_API_KEY`):

| Endpoint | Method | Key inputs | Key outputs | Errors to handle |
|---|---|---|---|---|
| /dca/collector | POST | name, deliver stub webhook | collector id | auth, quota |
| /dca/collectors/{id}/automate_template | POST | description, urls array | job id | generation failure |
| /dca/collectors/{id}/automate_template/progress | GET | none | status: queued/planner/running/done/failed | poll timeout |
| /dca/trigger | POST | collector param, body: array of {url} | collection id, start_eta | transport errors, poll timeout |
| /dca/dataset | GET | id param | array body when ready, else building | poll timeout |
| /dca/collectors/{id}/refactor_template | POST | prompt, custom_input: [] | job id | none destructive |
| /dca/collectors/{id}/refactor_template/progress | GET | none | status, then pending_answer at step user_approval | poll timeout |
| /dca/collectors/{id}/resume_automation_job | POST | message: true | resumes to done | approval required |

**Collector contract** (the description sent to automate_template on create, with the exact output shape the mapper will read):

> Extract the full text content of this documentation page in reading order. Return a single JSON object per page: {"title": string, "blocks": [{"type": "heading", "level": int, "text": string}] or [{"type": "paragraph", "text": string}] or [{"type": "code", "code": string}]}. Use heading levels 1 to 3 only, keep code blocks verbatim, include page content only, no navigation, menus, ads, or footer boilerplate.

Generation runs against a sample url: the first discovered page of the source. The collector is named from the source url slug and given the stub webhook deliver target, matching the skill's create flow.

**Dataset row contract** (confirmed by the live probe during build, task 4): each ready row carries the input url under `input.url` (a top level `url` field is also accepted) plus the extraction at the top level: `title`, `blocks`, `raw_content`, `raw_content_url`, and `product_page_url`. `raw_content` holds the full page markdown and is preferred by the mapper; top level `title` and `blocks` are reassembled only when `raw_content` is absent. A row that is absent, carries an `error` field, or has unusable extraction counts as failed for that url. Per batch the invariant holds: counted rows plus failed urls equals submitted urls. The mapper is defensive about field names since the shape is external.

**Markdown serialization** (feeds the sectioner and its heading path citations): title becomes an h1; each block maps by type, heading level to atx headings (`#`, `##`, `###`), paragraphs to text with blank line separation, code blocks to fenced code with the fence on its own line. A row whose extraction is instead an html string is converted with the existing turndown service, and a plain text string is used as is.

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| ensureCollector | collector id | created via POST /dca/collector, stored in meta key `scraper_collector_id` immediately after creation, before generation finishes |
| ensureCollector | generation sample url | the first same-origin discovered page of the source (`automate_template` rejects cross-origin urls, and a second sample can trip a server side validation bug, so one is used) |
| ensureCollector | collector name | slug of the source url |
| runBatch | page markdown | mapped from the /dca/dataset result rows, reassembled by the collector contract, defensive about row shape |
| crawl | skipped page decision | sha256 content hash over normalized markdown, unchanged from today |
| runBatch | failed urls | derived: a url is failed when it has no row, an error row, or unusable extraction; counted plus failed equals submitted per batch |
| heal trigger | heal prompt | derived: "Extraction comes back empty for N pages including <first failing url>", with the failing url set |
| heal trigger | heal decision | derived: extraction empty or below `MIN_USABLE_TEXT_LENGTH`, and only when at least `SCRAPER_HEAL_MIN_FAILURES` pages fail |
| heal cap | max heals per crawl | constant `SCRAPER_MAX_HEALS`, default 1 |
| fallback decision | use SDK scrapeUrl | derived: page still unusable after heal, handled by the private `sdkFetchPages` helper |
| crawl | progress notes | the existing `onProgress(note)` third argument: "generating collector, polled 5 of 60" during creation, "fetched X of Y" only once batches run |

**Key invariants**:
- A source holds at most one collector id in meta; crawl never creates a second while one is stored.
- Every page's markdown flows through the Scraper Studio path unless it fails after healing, in which case the SDK fallback runs before the page is skipped.
- Unchanged pages are never reindexed; the content hash semantics are identical to today.
- The `fetchPagesAsMarkdown` signature does not change, so discovery, section, chunk, embed, and ask are untouched.
- One batch trigger runs per crawl; no per crawl chunking.
- Healing runs only on extraction quality failures, never on transport failures or a dataset poll timeout; transport and timeout urls go to the SDK fallback instead.
- Retries: 3 attempts, exponential backoff of 1, 2, and 4 seconds, retried only on 429, 5xx, and network errors.
- Failed accounting per batch: counted rows plus failed urls equals submitted urls.
- On any terminal generation or heal failure, the collector id is surfaced to the user and the remaining pages flow through the SDK fallback.

**Security model**:
- `crawl` still requires an authenticated user, unchanged.
- All Scraper Studio calls go over HTTPS with the bearer key, resolved from the environment first and stored credentials second, exactly like today. The key is never logged.
- Only public documentation pages are fetched; no regulated data is involved, so no compliance scope applies.

**Configuration required**:
- `SCRAPER_GENERATION_TIMEOUT`: seconds to poll collector generation and heal progress, default 900 (optional)
- `SCRAPER_DATASET_TIMEOUT`: seconds to poll the dataset, default 3600 (optional)
- `SCRAPER_POLL_INTERVAL`: seconds between dataset and progress polls, default 10 (optional)
- `SCRAPER_MIN_USABLE_TEXT_LENGTH`: characters of assembled markdown below which extraction counts as empty, default 200 (optional)
- `SCRAPER_HEAL_MIN_FAILURES`: failed pages that trigger a heal, default 2 (optional)
- `SCRAPER_MAX_HEALS`: self healing runs per crawl, default 1 (optional)
- No new required variables; `BRIGHTDATA_API_KEY` authenticates everything.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: first crawl of a fresh source creates a collector, polls to done, stores the id, then a single batch run maps rows to markdown and index works; a second crawl reuses the id and skips unchanged pages, verifies **AC-1**, **AC-2**, **AC-3**
- Failure case: several pages come back with empty extraction, the heal flow triggers above the failure floor, auto approves, reruns, and returns usable text, capped per crawl, verifies **AC-4**
- Fallback: a page is still empty after healing, the SDK scrapeUrl path fetches it; if that also fails the page is skipped with a warning, verifies **AC-6**
- Big site: 500 discovered pages complete through one batch trigger with all pages accounted for, verifies **AC-5**
- Transport failure: a dataset poll times out, the batch urls go to the SDK fallback and no heal runs, verifies **AC-4**, **AC-6**
- Config: crawl runs with only the existing env vars set, verifies **AC-7**
- Suite: `npm test`, `npx tsc --noEmit`, `npm run build` pass and a small site answers a question end to end, verifies **AC-8**

## Build plan

1. [x] Add `META_KEYS.SCRAPER_COLLECTOR_ID` and `src/lib/scraper-studio.ts`: the REST client with ensureCollector (create, persist id immediately, automate, poll progress with `SCRAPER_GENERATION_TIMEOUT`), runBatch (one trigger, poll dataset with `SCRAPER_DATASET_TIMEOUT`), mapRowsToMarkdown (defensive row matching, markdown serialization, failed accounting), and healCollector (refactor, poll, auto approve, poll again, rerun), satisfies **AC-1**, **AC-2**, **AC-4**
2. [x] Split the SDK logic into a private `sdkFetchPages` helper and add the orchestrator in `src/lib/fetcher.ts` so crawl ensures the collector on first use, runs one batch trigger, heals on extraction failures, and falls back to `sdkFetchPages` for transport and post heal failures; hash skip and resume preserved, satisfies **AC-1**, **AC-3**, **AC-5**, **AC-6**, **AC-7**
3. [x] Self healing on unusable extraction with the failure floor and per crawl cap, and the retry policy on transient API failures, satisfies **AC-4**
4. [x] A live probe of the dataset row shape against a real batch run, used to lock the mapper contract and its fixture, satisfies **AC-2**
5. [x] Unit tests for mapRowsToMarkdown (including the fixture from the probe), the heal decision, the retry policy, and the failed accounting with mocked /dca payloads, satisfies **AC-8**
6. [x] Update the README pipeline description, then run the suite and a small end to end crawl that answers a question, satisfies **AC-8**

## Consequences

**Positive**:
- Scraper Studio becomes the centerpiece of the fetch stage, earning the centrality and reliability contest criteria.
- Self healing means a changed site is fixed in place instead of silently dropping content.
- The SDK fallback keeps today's coverage as a safety net.

**Negative / tradeoffs**:
- Two fetch paths to maintain.
- Scraper Studio runs bill credits, so every crawl costs more than the SDK path alone; the collector itself is free to reuse.
- Collector generation adds 5 to 10 minutes to the first crawl of a fresh source.
- Extraction quality depends on the collector prompt; a weak prompt means more heals.

**Neutral**:
- Existing indexed data and stored pages are untouched; the new engine takes over on the next crawl of each source.
- The stored collector id in meta is inert until a crawl runs, and harmless if the change is reverted.

## Follow-up

- [ ] `scraper-studio` conventions are not yet in root `AGENTS.md`; the skill governs this fetch design and belongs there before implementation (do not add it to a nested file, fetch affects every source)
- [ ] Consider whether the collector prompt should be overridable per source through an env var if a site extracts poorly in practice
- [ ] The live run showed extraction yield varies with generation: one collector (generated after a timed out first run) extracted only its sample page across three batches, while a fresh generation extracted every page in one batch. If a source extracts poorly, heal with a prompt that names failing pages, or regenerate by clearing the stored collector id
- [ ] `automate_template` quirks seen live: it rejects cross-origin sample urls, and a second sample (a plain text file) tripped a server side `sprintf invalid format %j` 500. The client sends one same-origin sample for this reason

## Migration plan

**Strategy**: strangler

**Phases**:
1. Add the Scraper Studio client and wire crawl so a source with a stored collector id fetches through Scraper Studio; sources with no id still fetch through the SDK. Deploy.
2. Cut over: crawl ensures a collector on first use, so every source now fetches through Scraper Studio with the SDK as fallback.
3. Tune optional knobs (generation timeout, heal floor, heal cap) as real runs demand.

**Rollback**: revert the fetcher and command changes to the previous commit; existing indexed data is untouched, and the stored collector id is inert until a future crawl uses it again.

**Risks**: collector generation time on first crawl; credit cost of each run; the /dca dataset row shape is an external contract, so the mapper must be defensive about field names and shapes; extraction yield depends on generation quality, so a source can lean on the SDK fallback until the collector is healed or regenerated.

## Rationale

Reasoning and options: see rationale.md.