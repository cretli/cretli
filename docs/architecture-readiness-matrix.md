# Architecture program — readiness matrix and rollout evidence (stage 7)

Status: **evidence report, proposed with the stage-1 ADR** ([architecture-target-adr.md](architecture-target-adr.md)).
Machine-readable twin: [architecture-readiness-matrix.json](architecture-readiness-matrix.json).
Stage 7 collects evidence and records readiness. It implements **no** migration and does **not**
re-run A4 `6e483edd`, A6 `9ef8ceca`, R19 `b0e4df18`, R20 `169307f8` or any cutover. Files under
`lib/storage/`, `lib/persist/delegation-migrate.js`, `docs/storage-registry.json`,
`docs/storage-contract.md` and `docs/MULTI-INSTANCE.md` were read only.

Evidence labels used below:

- **verified** — a test or command in this report was run and passed (see section 6).
- **claimed** — stated by a document, an earlier stage or a TODO body; not re-verified here.
- **absent** — nothing exists in the repository.

## 1. Material base and what is actually integrated

| Item | Fact |
| --- | --- |
| Stage 1-6 artifacts | Checkpoint commits on the worktree branch of root `7ec86917` (head `08c9699`); **not** in the main checkout, **not** in the target branch `next/2026-09-28`. |
| Root integration | `unconfirmed`, aggregate 0/8 confirmed (read via `todo_show`). |
| Plan v6 | Approved by a human 2026-10-17T19:02:18Z; plan review state `stale`. The ADR is still `proposed` (`acceptedBy` / `acceptedAt` empty). |
| Consequence | "Done" stages 2-6 mean *delivered on the branch*. No vertical below is integrated, and none is marked complete. |

## 2. Dependencies — current state (read during stage 7, not copied)

Read with `todo_show` at about 2026-10-17T21:42Z. `ready` means not started.

| Item | TODO | Status | Integration | Review |
| --- | --- | --- | --- | --- |
| Storage project | `cf4fed89` | doing | partial (1/7: A1) | children: none 5, pending 1 |
| A1 registry / baseline / decision | `7a287da9` | done | **integrated** (target `next/2026-09-28`) | pending (1) |
| A2 backend + transactions | `4fb174ca` | ready | unconfirmed | none |
| A3 parent (history, then metadata) | `706509ca` | ready | unconfirmed | none; plan not approved |
| A3a history pilot | `aadeac30` | ready | unconfirmed | none |
| A3b chat metadata | `c688a6a1` | ready | unconfirmed | none |
| A4 operational state transactions | `6e483edd` | ready | unconfirmed | none |
| A5 remaining data / backup integration | `88131b70` | ready | unconfirmed | none |
| A6 cutover + restore drill | `9ef8ceca` | ready | unconfirmed | none |
| Backup project (parent of B4) | `68f1c312` | doing | awaiting (0/7) | children: none 6, pending 1 |
| B1 archive contract | `5cf09e77` | doing | awaiting (patch ready) | pending (1) |
| B4 offline backup / restore | `09f85444` | ready | unconfirmed | none |
| Recovery program | `53efd61e` | doing | unconfirmed (0/20) | children: none 14, passed 5, unknown 1 |
| R1-R12 | various | done | unconfirmed | R8-R12 passed; R1-R7 none |
| R13 UI + watcher D | `e304b86d` | ready | unconfirmed | unknown |
| R14 policy | `deceb4da` | ready | unconfirmed | none |
| R15 scheduler | `c3665531` | ready | unconfirmed | none |
| R16 supervisor | `92ddf55f` | ready | unconfirmed | none |
| R17 OOM | `bfddf491` | ready | unconfirmed | none |
| R18 corrections | `ad5baa10` | ready | unconfirmed | none |
| R19 crash tests | `b0e4df18` | ready | unconfirmed | none |
| R20 automatic opt-in | `169307f8` | ready | unconfirmed | none |

Dependency chain (storage-contract): A1 → A2 → A3a; A3b needs A3a **and** B4; A4 → A5 → A6 follows A3b.
Only A1 is integrated. Every other storage link in the chain is `ready`/`unconfirmed`.

## 3. Readiness matrix per vertical

Decision vocabulary: **GO-additive** (additive read-side change, owner may integrate), **GO-review-only**,
**MEASURE-FIRST**, **NO-GO**. No row is marked complete
(`completionAllowed: false` in the JSON) because nothing is integrated and several rows wait for other programs.

| Vertical | Delivered by stages 1-6 (files / tests) | Storage / recovery dependency (state now) | Decision | Rollback |
| --- | --- | --- | --- | --- |
| **V0** request-local chat index | snapshot `065f3d5`: `lib/routes/delegations-routes.js`, `tests/delegation-route-chat-index.test.js` | none | GO-review-only; **NO-GO to commit** without a user order | revert the `WeakMap` block |
| **V1** chat catalog read model | `lib/chat-catalog.js`, `loadChatsSnapshot()` in `chats-persist.js`, `GET /api/chats/page`; tests `chat-catalog-contract`, `chat-catalog-pagination`, `architecture-http-fixture` | A2 (store-level non-copy read) and A3b (metadata writer) — both ready/unconfirmed; writer untouched | GO-additive for the read side; NO-GO for zero-copy store reads and any `chats.json` change | `loadChats()` and `GET /api/chats` unchanged = JSON fallback |
| **V2** sidebar / list DTO + sync | `lib/chat-list-dto.js`, `lib/chat-list-sync.js`, `chatListSyncClient.js`, `api.js`; tests `chat-list-sync`, `chat-list-sync-client`, `chat-list-live-sync-delta` | R13 `e304b86d` (ready, review unknown), A3a (ready) | GO-additive for non-history, non-recovery lists; NO-GO for recovery statuses, history parts, switching the live sidebar | DTO version flag; old list endpoint kept |
| **V3** history page / search / replay | nothing (blocked by design) | A2 → A3a, both ready/unconfirmed | **NO-GO** | A3a rollback + reverse export (see section 7) |
| **V4** frontend entity model | Existing signal/state modules; experimental entity-store/shadow path removed | V2; replacement contract and real browser acceptance are not available | NO-GO until a replacement is specified and measured | retain the established renderer/state path |
| **V5** TODO / Watcher / delegation aggregates + tick | profile only (`architecture-stall-profile.*`) | A4 (needs A3b), R14-R20 — all ready/unconfirmed | **NO-GO** | revert aggregate to full scan; storage side via reverse export |
| **V6** blocking primitives | `lib/files-list.js` (one shared `Intl.Collator`); stall profile; tests `files-list-order`, `architecture-stall-profile` | storage-owned sites: A2/A4/A5; owner-lock probe: R3 follow-up | GO-additive for the files-list change; NO-GO for the rest | per-site revert |
| **V7** boot / navigation / Settings | settings measured, shell measured (no `sw.js` change); test `sw-shell-assets` | none, but the cold/warm/offline baseline is absent | MEASURE-FIRST | revert endpoint/cache change |
| **V8** Files / Terminal / Browser overhead | Cretli-side overhead measured; real shell / Chromium **not measured** | none | MEASURE-FIRST | n/a |
| **V9** observability + fixtures | HTTP fixture + bench, stall profile, chat-list bench, inventory, cycle report | none | GO-additive (artifacts); mixed >= 10 min and 20-cycle checks absent | n/a |
| **V10** migration integration + multi-instance | this report, `tests/multi-instance-regression.test.js`, `scripts/architecture-multi-instance-regression.mjs` | A2, A3a, A3b, A4, A5, A6, B4 — all ready/unconfirmed | GO-additive for matrix + regression set; **every cutover NO-GO** | per-store reverse export / reconciliation |

## 4. Explicit NO-GO list (a dependency is not integrated)

Nothing on this list may be reported as complete or started by this program.

1. **V3** history page / search / replay — A2 `4fb174ca` → A3a `aadeac30`.
2. **V1** store-level non-copy chat reads and the `chats.json` → metadata-store move — A2, A3b `c688a6a1` (needs A3a + B4 `09f85444`).
3. **V2** recovery statuses in sidebar/history — R13 `e304b86d`.
4. **V2/V4** history views and the durable-ACK consumer — A3a.
5. **V4** replacement shared-state model — a new contract and real desktop/mobile acceptance (S8), plus R13 and A3a for their parts.
6. **V5** SQL aggregates and transactions — A4 `6e483edd` (needs A3b).
7. **V5** scheduler / supervisor / OOM / policy / corrections / crash tests / opt-in — R14-R20 (`deceb4da`, `c3665531`, `92ddf55f`, `bfddf491`, `ad5baa10`, `b0e4df18`, `169307f8`).
8. **V6** storage-owned `Atomics.wait` sites — A2, A4, A5; `delegation-owner-lock` probe — R3 follow-up decision.
9. **V7** boot/shell/cache changes — cold/warm/offline baseline.
10. **V10** cutover of every store: history (A3a), metadata (A3b), operational state (A4), remaining data (A5), final drill (A6) — plus B4 as the offline-restore prerequisite of A3b.
11. **Usage journal migration** — stays authoritative (storage-gates, backend decision); only A5 with a separate numeric justification.
12. **V0 commit** and integration of any stage 1-6 artifact into the target branch — explicit user order.

## 5. Cutover readiness gates (what must exist before any store moves)

The program does not implement a second migration. Per `docs/storage-contract.md` each slice needs the following;
the "today" column records what exists in the repository now.

| Gate | Today |
| --- | --- |
| Registry of stores, writers, locks, markers, validators | **verified**: `lib/storage/store-registry.js`, `docs/storage-registry.json` (28 stores), `tests/storage-registry.test.js` passes. 5 `inventoryGaps` remain (claimed by the registry). |
| Backend decision and numeric gates | **claimed**: `docs/storage-backend-decision.md` selects sqlite-worker on baseline evidence; nothing is implemented (`lib/storage/` has no worker). |
| Source backup + strict raw validation / quarantine | **absent** for history/metadata (B4, A2). |
| Hash / count / ref checks on staging | **absent** (A3a/A3b acceptance). |
| Single-writer fencing above external high-water mark, maintenance coordinator | **absent** for storage (A2); recovery owner lease with generation fencing exists and is **verified** (`tests/recovery-owner-lease.test.js`). |
| Durable markers + receipts / idempotency | **absent** for history (A3a). |
| Restore drill and legacy-archive reader / forward migration | **absent** (B4, A6). |
| Reverse export / reconciliation after new writes | **absent**: only described in `persistence-design.md` and `storage-contract.md`; no code. |
| Explicit per-domain readiness and client compatibility | this report; client v1/v2 write rejection is A3a's. |

## 6. Multi-instance regression set (docs/MULTI-INSTANCE.md semantics)

Runner (existing and new tests, one Node process per file, same convention as `scripts/run-unit-tests.mjs`):

```
node scripts/architecture-multi-instance-regression.mjs --json <out.json>
```

Result in this run: **18/18 files passed**, exit 0 (7 multi-instance, 10 stage 2-6, 1 V0). Three more files were run
separately and passed: `tests/storage-registry.test.js`, `tests/files-list.test.js`, `tests/chat-history-revisions.test.js`.

| Scenario from MULTI-INSTANCE.md | Test | Label |
| --- | --- | --- |
| Owner holds the lease; a non-owner cannot register, refresh or unregister it | `tests/multi-instance-regression.test.js` (new, in-memory Redis double with a virtual clock) | **verified** against the double; real Redis semantics **claimed** |
| Failover only after the owner TTL (no steal at 119 s, claim after 121 s); clean unregister releases at once | same | verified (double) |
| Limits: TTL default 120 s, floor 30 s (below falls back to 120), fractional TTL floored | same + `sdk-room-registry.test.js` | verified |
| Non-owner is a read-only stub: no Agent, no prompt runner, never persists history, stale/duplicate seq ignored, replay log cap honoured | same + `sdk-remote-room-stub.test.js` | verified |
| Owner-side room persists history | `tests/sdk-owner-history-persist.test.js` (real owner room: `broadcastRoom` → `pushRoomEvent` → `persistRoomEventFromPayload`, then reads the durable store and asserts the transient payloads write nothing) | **verified** — the test drives the production owner path; `ingestRemoteRoomEvent` only ever sees stubs, so it no longer passes a dead `persist` handler |
| Sticky cookie `cretli-instance` | `sdk-sticky-session.test.js` | verified |
| Room bus local mode | `sdk-room-bus.test.js` | verified (Redis pub-sub mode **absent**) |
| Browser is single-instance (503 `browser-multi-instance-unsupported`) | `browser-multi-instance.test.js` | verified |
| Recovery owner lease: takeover exactly at TTL, generation +1, PID reuse, two-process race | `recovery-owner-lease.test.js` | verified (a different lease from the SDK room lease) |
| Stages 1-6 did not touch `lib/sdk/`, `lib/browser/`, `lib/recovery/`, `lib/storage/`, `delegation-migrate.js`, storage/multi-instance docs | `git diff --name-only 065f3d5 HEAD` | **verified** by diff |

Gaps (not covered by any test, not added because they need the full WS module): the `remote_room_stub` error
returned by `startSdkChatRun` / `sendRemoteRoomStubError` in `lib/sdk/cursor-agent-sdk-ws.ts`; the WS event replay
cap (1200); and Redis pub-sub delivery. They are covered by code reading only (**claimed**). The former gap for
the owner-side history persistence path (`broadcastRoom` → `pushRoomEvent` → `persistRoomEventFromPayload`) is
covered by `tests/sdk-owner-history-persist.test.js`, and the dead `persist` handler in `ingestRemoteRoomEvent`
was removed because that function only ever handles remote stubs.

## 7. Rollback

Per vertical: see the matrix. For anything that touches a store, `docs/storage-contract.md` is binding: a snapshot
is enough only **before** new writes; **after** new writes rollback needs reconciliation / reverse export, and
legacy archives need their registered reader plus forward migration while paused. No reverse-export tool exists
yet, so every cutover stays NO-GO until its owner (A3a, A3b, A4, A6) delivers and rehearses it. Removing a
replaced active path is the vertical owner's job after acceptance; readers of old archives and forward migrations
must stay.

## 8. V0 coordination — request-local chat index (nothing was committed)

The decision to commit belongs to the user. Evidence, read-only:

| Location | Files / hunks | Belongs to |
| --- | --- | --- |
| Main checkout (dirty, branch `next/2026-09-28`, head `576b016`) | `lib/routes/delegations-routes.js`: 2 hunks (`@@ -203,0 +204,8` the `requestChats` `WeakMap`, `@@ -205 +213,9` the `findParent` body), +17/-1; `tests/delegation-route-chat-index.test.js` (untracked, 107 lines) | **V0** — byte-identical to snapshot `065f3d5` |
| Main checkout | `lib/mcp/mcp-vendor-map.js`: 3 hunks (`@@ -36`, `@@ -42/+43`, `@@ -47/+49,11`), +13/-1 (`codexBridgeApproval`) | **unrelated** — byte-identical to snapshot `065f3d5`; split it out |
| Main checkout | `lib/worktree/git-worktree.ts` (+37/-20) and `tests/git-worktree-ownership.test.js` (untracked, 102 lines) | **unrelated, newer than the snapshot** — not part of V0 or stages 1-6 |
| Worktree branch `065f3d5..08c9699` | all `docs/architecture-*`, `lib/chat-catalog.js`, `chat-list-*`, `app_front/*`, `scripts/architecture-*`, tests of stages 2-6 | **stage 1-6 artifacts** — absent from the main checkout |
| Worktree branch | `lib/routes/delegations-routes.js` +7/-9 (stage 3): replaces the V0 `Map` snapshot with `readChatCatalog()` inside the same `findParent` | **overlaps V0** |

Ordering recommendation (evidence-based, user decides):

1. Commit V0 first and alone: `lib/routes/delegations-routes.js` + `tests/delegation-route-chat-index.test.js` only. Stage 3's hunk is written against the V0 text, so integrating stage 3 without V0 would not apply cleanly.
2. Keep `lib/mcp/mcp-vendor-map.js` and `lib/worktree/git-worktree.ts` + its test out of that commit (separate owners / commits).
3. Integrate stage 1-6 artifacts only after V0 and by the vertical owners; V1 supersedes V0 for these routes.
4. Verified in this run: `tests/delegation-route-chat-index.test.js` passes on the worktree branch (with the stage 3 catalog). Not run: the same test on the main checkout's V0-only text (it is byte-identical to the snapshot, but was not executed there).

## 9. Remaining problems

- Nothing is integrated; the user and the vertical owners decide commits and integration.
- Plan v6 manifest entries for `architecture-target-adr.md`, `architecture-vertical-dag.md`, `architecture-baseline.md` and `ARCHITECTURE.md` are stale; see `architecture-manifest-stage7.json`.
- Stage 5 code review is `pending`; stage 2 review state is `unknown`.
- `tests/e2e/sidebar-render-metrics.spec.js`, real desktop/mobile runs, mixed >= 10 min and the 20-cycle leak check were not executed.
- Open non-blocking follow-up TODOs from stages 2, 3, 5 and 6 reviews exist in status `idea`; they were not changed here.
