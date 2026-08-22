# 0003. Scraper Studio as the page fetch engine, rationale

**Date**: 2026-08-19
**Status**: part of spec 0003 (status lives on `index.md`)

## Context

The tool's pipeline is solid but its fetch step is generic: one API call per batch through the Bright Data SDK, raw page returned, HTML converted locally with turndown. That works, but it is invisible and interchangeable. The tool is being prepared for the Bright Data contest, and one judging criterion asks whether Scraper Studio is central to the project. Today it appears nowhere in the code (basis: the pipeline spec, and a scan of `src/`).

Making Scraper Studio the fetch engine changes that. It also brings a real operational upgrade: Scraper Studio collectors are described in plain English and built by an AI flow, and they self heal when a site changes, which is the natural answer to the "reliability and self healing" criterion.

The constraints shape the design. Scraper Studio runs bill credits, so the collector must be created once and reused, never rebuilt per crawl. Generation takes 5 to 10 minutes, so the create step must happen once on the first crawl of a source and be visible to the user. The tool runs as a headless CLI with no installed `bdata` CLI, so all calls go direct to the Bright Data REST API with the existing `BRIGHTDATA_API_KEY`. The fetch interface `fetchPagesAsMarkdown` must keep its signature so content hash skip, resume, and rebuild survive untouched. And extraction must feed the existing markdown pipeline as markdown, never a new shape.

## Options considered

### Option 1: Fix in place

Keep the SDK scrapeUrl fetch and only tune concurrency and retries.

**Pros**:
- No new cost, no migration, nothing to maintain.
- Zero risk to the working pipeline.

**Cons**:
- Scraper Studio stays entirely out of the product, so the contest criterion on its centrality stays unmet (basis: the contest rubric you shared).
- No self healing; a site redesign silently breaks fetch with only warnings.
- The tool remains interchangeable with any scrape API.

### Option 2: Replace with strangler, SDK kept as fallback

Scraper Studio becomes the primary fetch engine through direct REST calls, and the existing SDK path stays behind for pages that still fail after healing.

**Pros**:
- Scraper Studio becomes the centerpiece of the fetch stage, which is exactly what the contest criterion asks for (basis: the contest rubric you shared).
- Self healing gives real reliability value, not just a demo line.
- The fallback keeps today's coverage as a safety net, so a Scraper Studio outage or a bad extraction does not strand pages.
- Cutover is incremental and one commit revert rolls it back; existing indexed data is untouched.
- Direct REST from Node adds no CLI dependency and reuses the existing key.

**Cons**:
- Two fetch paths to maintain.
- Both paths bill credits, so a fallback run costs extra.
- The collector prompt quality decides extraction quality; a weak prompt means more heals.

### Option 3: Replace directly, Scraper Studio only

Same engine as Option 2 but the SDK path is deleted.

**Pros**:
- One fetch path, the strongest possible "Scraper Studio central" claim.
- Less code than Option 2.

**Cons**:
- Any Scraper Studio failure or persistent extraction gap strands those pages with no net, which risks the reliability criterion it is meant to serve.
- You chose to keep the SDK as a fallback, so this overrides a stated preference for no real gain (basis: your answer on the fallback question).

## Rationale

The contest rubric names Scraper Studio centrality and reliability as judging criteria, and this is the option that earns both honestly. Scraper Studio genuinely carries the fetch load, so it is central, and its self healing flow is the real mechanism that keeps a changed site fetchable, which is the substance behind the reliability line. Direct REST from Node keeps the tool dependency free: no CLI install, one reused key, and the endpoints are stable and documented in the installed skill (basis: the scraper-studio skill, its api flow reference).

The SDK fallback is the trade that keeps the change safe. Scraper Studio is excellent but external; generation can fail, a dataset can be slow, and extraction quality depends on the prompt. Keeping the proven SDK path for the last mile of failures means a page is only ever dropped after two engines tried, which protects the demo and the reliability claim alike. The cost is two paths to maintain, which is acceptable for the reliability it buys.

The create once per source design respects the economics: generation is the expensive part, so it happens exactly once and the id is persisted, while every later crawl is a cheap batch rerun of an existing collector.

## References

**Project sources** (verifiable, in this repo):
- `AGENTS.md`, the pipeline and fetch conventions
- spec 0001, the architecture and the current SDK fetch decision
- the `scraper-studio` skill (`.agents/skills/scraper-studio/`), including its api flow reference for the exact endpoints, payloads, and status sentinels
- the contest rubric you shared, which names Scraper Studio centrality and reliability as criteria

**Practices & standards**:
- strangler pattern for replacing a live integration while keeping the old path as a safety net
- idempotent collector reuse: create once, persist the id, rerun the same collector