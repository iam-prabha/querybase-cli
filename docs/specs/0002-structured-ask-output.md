# 0002. Structured ask output for agents

**Date**: 2026-08-18
**Status**: Accepted

## Summary

`querybase ask` gains a `--json` flag that prints one machine readable document on stdout: the answer plus its cited sources as structured data. A script or agent can consume it directly instead of parsing console text. The console format stays the default, and errors keep the current behavior, a plain `error: ...` line on stderr with exit code 1.

## Context

The ask command currently prints a plain text answer followed by a Sources block. Humans read that fine, but an agent or script that wants to join the answer to its citations must parse the text. The search layer already returns structured fields (page url, heading path, text, score) through `SearchHit` in `src/lib/vector.ts`, so the data exists today; only the presentation lacks a machine readable mode. The goal is a stable contract an agent can rely on: one JSON document, well defined fields, and a failure signal that does not depend on what lands on stdout.

## Requirements

**User stories**:
- As an agent or script, I want `querybase ask --json "<question>"` so I can read a structured answer and its sources without parsing console text.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: `querybase ask --json "<question>"` prints exactly one JSON document on stdout containing `question`, `answer`, and `sources`, where `answer` is the generated text with its inline `[n]` citation markers and each source has `index`, `url`, `headingPath`, `text`, and `score`, with `index` starting at 1 and matching the `[n]` markers in the answer.
- **AC-2**: Without `--json`, ask prints the current console format (answer text plus the Sources list), unchanged.
- **AC-3**: When `--json` is set and ask fails (not logged in, no source configured, no indexed content, or a generation error), it prints a plain `error: ...` line to stderr and exits with code 1, and stdout carries no partial JSON.
- **AC-4**: `npm test` and `npx tsc --noEmit` still pass after the change.

## Options considered

### Option 1: Plain text output with a Sources block (the status quo)

The current behavior.

**Pros**:
- Readable for humans, no code to change.

**Cons**:
- No contract for scripts; an agent must parse the text to join the answer to its sources.

### Option 2: A `--json` flag emitting one JSON document

The change proposed here.

**Pros**:
- Explicit opt in; the default output is unchanged for humans; stdout stays a single parseable document.

**Cons**:
- A second output path to maintain, and the error semantics must be pinned so scripts can tell success from failure.

### Option 3: Always emit JSON on stdout (no flag)

**Pros**:
- One output path, nothing to opt in to.

**Cons**:
- Breaks the human readable default and forces a migration on anyone using the console format.

## Decision

**Chosen option**: Option 2: A `--json` flag emitting one JSON document.

The ask command gains a `--json` flag (a commander option, in the same style as the existing `--rebuild` flag on index). When set, stdout carries exactly one JSON document: `{ question, answer, sources }`. Errors keep the existing `fail()` behavior: `error: ...` on stderr, exit code 1, no partial JSON on stdout.

## Rationale

The search layer already returns structured fields, so the flag is a thin presentation layer over data that exists today. Keeping the console format the default protects the human workflow that already works. Errors stay on stderr with a nonzero exit code because stdout cleanliness is what lets a script trust the document; a JSON error object would complicate the contract without helping anything here, since the exit code is the standard failure signal for command line tools. The flag name matches the codebase's existing commander option style, and a single file spec matches the size of the decision.

## Feature design

**API surface**:

| Surface | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|
| `querybase ask --json <question>` | question, flag | one JSON document on stdout | login required (unchanged) | 1: missing login, no source, no hits, generation failure |
| `querybase ask <question>` | question | console answer plus Sources list | login required (unchanged) | 1: same |

**Value sourcing** (every value the action produces names where it comes from):

| Action | Value produced | Source |
|---|---|---|
| ask --json | question | the question input |
| ask --json | answer | `generateAnswer` output |
| ask --json | sources[].url | `SearchHit.pageUrl` (Qdrant payload) |
| ask --json | sources[].headingPath | `SearchHit.headingPath` (Qdrant payload) |
| ask --json | sources[].text | `SearchHit.text` (Qdrant payload) |
| ask --json | sources[].score | `SearchHit.score` (Qdrant query result) |
| ask --json | sources[].index | position in the hits array, 1 based, matching the `[n]` markers in the answer |

**Key invariants**:
- In JSON mode, stdout carries exactly one JSON document and nothing else.
- The `[n]` marker in the answer for a source equals that source's `index` field.
- The flag never changes retrieval, generation, or the console behavior.

**Security model**: unchanged from ask. Login required. No new credentials or data exposure.

**Configuration required**: none. No new env vars.

**Critical test scenarios**:
- Happy path: run `querybase ask --json "<question>"`, pipe stdout through `JSON.parse`, confirm the three top level fields and that each source's `index` matches a `[n]` marker in the answer, verifies **AC-1**.
- Regression: run ask without the flag, confirm the console format is unchanged, verifies **AC-2**.
- Failure: run `querybase ask --json` in a state that fails (no source configured, or logged out), confirm stderr carries `error: ...`, the exit code is 1, and stdout is empty, verifies **AC-3**.
- Static: `npm test` and `npx tsc --noEmit` pass, verifies **AC-4**.

## Build plan

1. Add the `--json` option to the ask command in `src/commands/ask.ts` and branch the output: in JSON mode print `JSON.stringify({ question, answer, sources }, null, 2)` where `sources` maps each hit to `{ index, url, headingPath, text, score }`, instead of the console block, satisfies **AC-1**, **AC-2**
2. Leave the console path and the existing `fail()` path untouched (errors stay on stderr, exit 1), satisfies **AC-3**
3. Update `README.md` with the `--json` example and the note that errors use stderr and exit code 1, satisfies **AC-2**
4. Run `npx tsc --noEmit`, `npm run build`, and `npm test`, satisfies **AC-4**

## Consequences

**Positive**:
- Agents and scripts get a stable machine readable contract with citations they can join to the answer.
- The human console experience is untouched.

**Negative / tradeoffs**:
- A second output path to keep in sync as ask evolves.
- Errors in JSON mode are still plain text on stderr, so a consumer reading only stdout sees no JSON on failure and must check the exit code.

**Neutral**:
- Field names (`headingPath`, `score`) follow the existing `SearchHit` names, so no new vocabulary.
- A future need for more formats can grow `--json` into `--format <name>`; not needed today.

## Follow-up

- [ ] When this feature ships and the workflow tier rises above Prototype, the scope row should be verified by `/check verify`; at Prototype the develop self check closes it.