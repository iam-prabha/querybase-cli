# Verify: Scraper Studio fetch · spec 0003 · updated 2026-08-19

_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Live run results (2026-08-19, FastHTML docs, 21 pages)

Verified live: collector created once and persisted, generation polled to done, one batch trigger fetched all 21 pages through Scraper Studio with no SDK fallback (AC-1, AC-2, AC-5); a second crawl reused the id and skipped unchanged pages (AC-3); a crawl with only the existing env vars ran fine (AC-7); index embedded 448 sections and a question was answered with a Sources list (AC-8). The mapper contract was probed against a real dataset: rows carry `title`, `blocks`, `raw_content`, `raw_content_url`, `product_page_url`, `input.url`, with the extraction at the top level and `raw_content` preferred.

Findings to remember: extraction yield varies with generation (one collector extracted only its sample page; a fresh one extracted everything); `automate_template` rejects cross-origin samples and a second sample can trip a server side 500; both the heal flow and the SDK fallback triggered during earlier runs and worked.

## Commands

- [ ] Fresh source (delete the `scraper_collector_id` meta row or init a new url): `querybase crawl` → prints `generating collector, polled N of M`, then the batch runs; check meta has `scraper_collector_id` set → AC-1
- [ ] Same source again: `querybase crawl` → no generation note, collector reused, unchanged pages counted as skipped → AC-1, AC-3
- [ ] `querybase index` then `querybase ask "<question>"` → answer with a Sources list of real page urls and heading paths → AC-2
- [ ] Confirm one batch trigger per crawl: the crawl issues a single `/dca/trigger` (observed in Bright Data activity, or a site over 51 pages completes with no realtime limit error) → AC-5
- [ ] Force several empty extractions (edit a page so the collector's selectors miss, or temporarily lower `SCRAPER_MIN_USABLE_TEXT_LENGTH`) → the heal flow runs once (capped), auto approves, reruns, and the pages resolve → AC-4
- [ ] Make a page still fail after the heal → the SDK path fetches it; if the SDK also fails, a `warning: N page(s) failed to fetch, skipped` line lists it → AC-6
- [ ] Kill a crawl mid run, rerun it → completed pages stay (resume), unchanged pages are not reindexed → AC-3
- [ ] Run `crawl` with only the existing env vars set (no new ones) → it works → AC-7
- [ ] `npm test`, `npx tsc --noEmit`, `npm run build` all pass → AC-8

## Value-sourcing checks

- [ ] Collector id: created before generation finishes and reused on the next crawl (never a second create while one is stored) → collector id source
- [ ] Generation sample url: a same-origin discovered page (cross-origin samples are rejected); the collector name is the source url slug → sample url and name sources
- [ ] Failed accounting: counted pages plus failed urls equals submitted urls for a crawl that had failures → failed urls source
- [ ] Heal trigger: a single short page does NOT heal (below the floor), several do → heal decision source
- [ ] Transport failure: a dataset timeout routes the whole batch to the SDK, no heal runs → fallback decision source
- [ ] Progress notes: `generating collector, polled N of M` appears during creation, `fetched X of Y` only once batches run → progress source

## Acceptance-criteria coverage

- AC-1 covered by the fresh source step · AC-2 by the index and ask step · AC-3 by the rerun and resume steps · AC-4 by the forced empty step · AC-5 by the single trigger step · AC-6 by the post heal step · AC-7 by the env vars step · AC-8 by the suite step