# HTTP baseline (stage 3, V9)

Real Express app + real chats routes over loopback HTTP, isolated temp data dir (never `data/`). Auth/widget middleware is not mounted. Raw numbers: `architecture-http-baseline.json`; environment is recorded there.

Reproduce:
```
node scripts/architecture-http-bench.mjs --sizes 500,5000,20000 --profile full --samples 200 --out docs/architecture-http-baseline.json
node scripts/architecture-http-fixture.mjs --dir /tmp/cretli-fx --size 5000   # data dir only
```
Stage 4 re-run (same command, same seed) added `listSyncResync` (`GET /api/chats/sync?since=<foreign epoch>`: the explicit-resync answer), `pageListDto` (`/api/chats/page?view=list&archived=tree`) and `settings` (`GET /api/settings`, stub host context). Earlier rows were re-measured in the same run; differences against the stage-3 run are within run-to-run noise (e.g. 20000 `pageFirst` P95 10.9 -> 11.1 ms, `listLive` 34.4 -> 35.8 ms).

Smoke profile (tests): `--sizes 200 --profile smoke --samples 20`.

Fixture (profile `full`): 24 workspaces, ~35% forks, 40-level chain, up to 3000 live rows in one workspace, ~40% of the rest archived, 20 chats x 1500 history events, 400 TODOs, 600 delegations. Usage state is **not covered** (no stable writer yet).

n = 200 samples per endpoint, so every P99 is **exploratory** (stable P99 needs >= 1000).

| chats | endpoint | bytes | P50 | P95 | P99 (exploratory) | max |
|---|---|---|---|---|---|---|
| 500 | listLive | 157157 | 0.932 | 1.434 | 1.713 | 6.197 |
| 500 | listFullIndex | 187636 | 0.782 | 1.215 | 1.884 | 5.093 |
| 500 | pageFirst | 38174 | 0.352 | 0.549 | 0.84 | 1.13 |
| 500 | pageScopedHotGroup | 35323 | 0.677 | 0.898 | 1.234 | 1.656 |
| 500 | pageArchivedOnly | 44103 | 0.326 | 0.432 | 0.631 | 0.887 |
| 500 | listSyncResync | 162 | 0.162 | 0.268 | 0.565 | 0.625 |
| 500 | pageListDto | 35099 | 0.401 | 0.5 | 0.909 | 1.038 |
| 500 | settings | 6570 | 0.459 | 0.678 | 1.386 | 7.709 |
| 500 | titleHistory | 98 | 0.154 | 0.266 | 0.329 | 0.392 |
| 500 | seenNoop | 47 | 0.219 | 0.323 | 0.417 | 0.635 |
| 5000 | listLive | 1499938 | 6.228 | 9.57 | 12.324 | 13.448 |
| 5000 | listFullIndex | 1847434 | 6.714 | 11.043 | 12.201 | 13.341 |
| 5000 | pageFirst | 38237 | 1.467 | 1.797 | 2.523 | 3.371 |
| 5000 | pageScopedHotGroup | 35363 | 4.445 | 5.089 | 5.348 | 5.398 |
| 5000 | pageArchivedOnly | 43881 | 1.492 | 1.883 | 2.333 | 2.684 |
| 5000 | listSyncResync | 160 | 1.097 | 1.319 | 1.987 | 2.039 |
| 5000 | pageListDto | 35162 | 2.095 | 2.527 | 3.117 | 3.273 |
| 5000 | settings | 6570 | 0.46 | 0.736 | 1.044 | 5.332 |
| 5000 | titleHistory | 99 | 1.075 | 1.58 | 2.416 | 6.934 |
| 5000 | seenNoop | 47 | 1.151 | 1.452 | 2.062 | 3.051 |
| 20000 | listLive | 5372215 | 25.081 | 35.832 | 37.626 | 40.841 |
| 20000 | listFullIndex | 7594586 | 28.632 | 38.626 | 39.896 | 40.734 |
| 20000 | pageFirst | 38266 | 6.996 | 11.118 | 12.109 | 17.232 |
| 20000 | pageScopedHotGroup | 35369 | 18.785 | 20.361 | 21.127 | 28.744 |
| 20000 | pageArchivedOnly | 43995 | 6.753 | 10.987 | 11.62 | 15.51 |
| 20000 | listSyncResync | 163 | 4.972 | 9.617 | 10.536 | 12.159 |
| 20000 | pageListDto | 35191 | 9.913 | 13.282 | 14.516 | 20.31 |
| 20000 | settings | 6570 | 0.476 | 0.734 | 1.163 | 11.057 |
| 20000 | titleHistory | 100 | 5.117 | 10.529 | 11.983 | 12.63 |
| 20000 | seenNoop | 47 | 5.3 | 11.5 | 12.016 | 12.653 |

Times in ms.

## Reading

- `pageFirst` returns a constant ~38 KB (100 rows) while `listLive` grows linearly (157 KB -> 5.4 MB at 20000). Materialized/serialized records per first page are constant.
- Latency of the page endpoints still grows with chat count (e.g. 0.4 -> 6.8 ms P50) because `loadChatsSnapshot()` copies the full list per call; removing that needs a storage-owned non-copy read (blocked, see the Stage 3 section of `architecture-vertical-dag.md`).
- `titleHistory` / `seenNoop` cost is dominated by the same full-list read.

Not measured: rows/plans/sync pauses of SQL backends (no SQL chat backend exists yet), usage growth.

## Stage 4 additions (V2, V7)

- **`GET /api/settings` (V7, target P95 <= 100 ms):** P95 0.678 / 0.736 / 0.734 ms at 500 / 5000 / 20000 chats (P50 0.46-0.48 ms, 6570 B). The route does not read the chat list, so it does not grow with chat count; there was no hot spot to fix and the route is unchanged (before = after; no earlier measurement existed because the endpoint was not in the harness). n = 200 per endpoint, so P99 (1.0-1.4 ms) and max (5-11 ms, first-request outliers) are **exploratory**.
- **`pageListDto` vs `pageFirst`:** 35.2 KB vs 38.3 KB for 100 rows at 20000 chats. The synthetic fixture rows are tiny, so the DTO gain is small here; real rows carry provider session ids, `executionFolder` paths and summaries that the DTO drops. Not a claim of a real-data size win.
- **`listSyncResync`:** 163 B answer; grows with chat count like the other full-list reads (P95 9.6 ms at 20000) because the request still takes one catalog snapshot (the stage-3 copy cost). Delta answers for one changed row are a few hundred bytes (unit-tested, `tests/chat-list-sync.test.js`).
- **Observation cost (not in the table):** the first sync/page request after a store revision change runs one synchronous diff pass: ~25-35 ms at 20000 chats on this machine (micro-measurement, n = 8, exploratory), then every request at that revision is O(1). It is the price of keeping the writer untouched; removing it needs a storage-owned read (A2).
- Payload caps are the frozen human-decision values (page <= 100 rows / 128 KiB, response <= 1 MiB): all measured pages are 35-44 KB for 100 rows; `listLive` / `listFullIndex` at 5000+ chats exceed 1 MiB (1.5 MB / 1.8 MB at 5000) and are the legacy full-index reads that the paged/DTO/sync path replaces in stage 5.
