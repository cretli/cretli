# SQL `IN (...)` audit

SQLite caps bind variables per statement (`SQLITE_MAX_VARIABLE_NUMBER`). A list built
from data (chat ids, delegation ids) that scales with the number of chats must be passed
as one JSON parameter (`IN (SELECT value FROM json_each(?))`), never one `?` per element.
`tests/presence-degraded-scale.test.js` fails when a new `IN (${...map(() => '?')...})`
appears in `lib/` that is not listed here.

| Location | List source | Verdict |
| --- | --- | --- |
| `lib/persist/delegations-persist.js` `listDelegationsForChatIds` | all chat ids | Fixed earlier (9801c9e7): one JSON parameter. Covered by the 50k-chat scale test. |
| `lib/recovery/recovery-store.ts` `listRuns({ chatIds })` | caller-supplied chat ids | **Fixed here**: was one `?` per id; now `json_each(?)`. |
| `lib/persist/delegation-sqlite.js` `resolveCachedRows` | cache-miss delegation ids | Bounded: sliced into `PARSE_CHUNK` (500) per statement. |
| `lib/storage/chat-history-store.js` `readSeqs` | requested seqs | Bounded: rejected above `HISTORY_READ_SEQS_MAX` (256). |
| `lib/persist/delegation-mailbox-persist.js` `listMailboxByStatus` | mailbox statuses | Bounded: de-duplicated status enum (a handful of values). |
| `lib/recovery/recovery-store.ts` `listOpenRuns` | `RUN_ACTIVE_STATES` (+1) | Bounded: constant state list. |
| `lib/storage/schema/0004-chat-history-metadata.js` (2x), `lib/storage/history-sidecar.js` | `SIDECAR_TABLES` constant | Bounded: fixed table-name list. |

## Presence error isolation

Presence computation failures (`summarizeChatRunStates`, `loadPresenceMap`, watcher rows)
no longer reach the socket handler: `sendAgentPresenceToClient` and the flush catch the
error, bump `getAgentPresenceErrorCount()`, log at most one line per 30 s, and send an
empty snapshot with `degraded: true`. `subscribeChatListUpdates` and `attachClient` also
guard the subscribe hook. Attach snapshots are shared for 1 s (dropped on any dirty mark
or flush) so a reconnect storm computes the full map once.
