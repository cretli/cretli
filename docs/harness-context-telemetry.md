# Harness context telemetry

Cretli keeps two separate measurement streams:

- The usage ledger records billable token deltas and finished runs. Its input
  buckets distinguish input outside cache, cache reads and cache writes.
- `data/usage/context-samples.jsonl` records context observations. They describe
  occupancy at an instant and must never be added to billable token totals.

Codex is the first producer of the shared context stream; Claude is the second.
Claude emits the latest main-thread call as `sdkContextUsage` (input including
cache, output, cache-read tokens, window), and after each completed streaming
turn refines that same sample with the SDK `query.getContextUsage({ detail:
'summary' })` breakdown (`lib/claude/claude-context-breakdown.ts`). Only token
and block counts are kept; paths, tool names and text are dropped. A compaction
boundary advances the context epoch and clears the pending observation. Root-session CLI
readings carry input/output/total tokens, cache-read tokens, the reported window
and optional estimated text-category counters. Observations retain harness,
chat, run, attempt, delegation, model, role, workspace and context epoch for
later correlation. No prompt text, tool arguments, results or credentials are
copied into this stream.

The room kernel accepts normalized `context_usage` events. New producers can
use the same path when they can supply a timestamp and measured input/total
counters. Missing counters remain null. A restored reading from before the
current run is ignored. The same chat/epoch/observation timestamp identifies one
sample; later refinements replace that sample in the read model rather than
increasing its count.

The append-only journal keeps at most 5,000 unique observations within 92 days,
with periodic atomic compaction and an 8 MiB compaction threshold. Readers skip
torn records, and the next append separates a torn tail from the new record.

`GET /api/usage/context-samples` supports the existing usage date range and
filters `harness`, `chatId`, `workspaceFile`, `workspaceFolder`, `model`, `runId`,
`delegationId` and `role`. Widget and integration callers cannot access it.

Harness health exposes `tokenUsage` from the usage ledger and `contextUsage`
from the context stream. Cache hit percentage is cached input divided by all
input in the ledger, not an average of per-call percentages. Context averages
and peaks use observations with a known window; they are sampled occupancy,
not total consumption. Breakdown estimates remain attached to observations for
future analysis and are never treated as measured allocations.

## Cache series and break detection

`GET /api/usage/context-cache-series?chatId=…` is harness-agnostic: it reads the
shared sample stream for one chat and returns `points` (context size, cache read
and write, fill and cache percent per call) and `breaks`. A break is a call whose
cache read falls below half of the previous call's and the cache hit share
also falls substantially (with at least 2,000 tokens cached before). A smaller
context that remains highly cached is not a cache break. Labels describe
correlation, not a confirmed provider cause: model change, an explicit
compaction/reset, idle gap, possible change to instructions/tools, new run or
unknown. The persisted fingerprint covers only Cretli's instruction/tool
configuration; it is not OpenAI's internal prefix or routing key. The tokens
outside cache are reported separately from cache-write tokens; they cannot be
labelled as tokens definitely reprocessed from old context.

When Codex supplies `token_usage_record`, response and turn ids identify the
call. Subsequent `token_count` reports for that same call retain its original
observation time and replace its sample. Cache writes, reasoning tokens and
thread-wide cumulative counters are preserved as additional numeric evidence.
Cumulative/session counters never become a context size or an added ledger
charge, and they can span several models.

## Cache expiry countdown

`GET /api/usage/cache-freshness?chat_id=…` also returns `countdown`: the expiry
time, remaining time and lifetime source for one chat, built by
`lib/usage/cache-countdown.ts`. It is harness-agnostic and works from the cache
tracker, falling back to the newest context sample after a restart.

The lifetime is taken in this order: the lifetime reported on a cache write
(`cacheWrite5mTokens` / `cacheWrite1hTokens`, Claude), the configured retention,
then the harness default. Claude defaults to 5 minutes (1 hour with
`claudePromptCaching1h`), measured from the start of the request, and a hit
refreshes it. Codex does not report the applied expiry, so its countdown is
`unknown`; cache hits remain observable. OpenAI API retention depends on model
and configuration and cannot establish a five-minute guarantee for Codex plan
traffic. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
