# ADR-0001: Target architecture — modular monolith with local single-writer storage

| Field | Value |
| --- | --- |
| Status | **proposed** |
| acceptedBy | _(empty — set only from an authentic UI approval event of the root plan version that pins this file's SHA-256)_ |
| acceptedAt | _(empty)_ |
| Revision | material base commit `065f3d54a1c330b43cc8b0ba74a55e851970a932` (no dirty patch other than the files added by this leaf); content identity = SHA-256 in the manifest of root plan `7ec86917-118f-4272-a7d6-d6cb2da3d7d8` |
| Owner TODO | `103827ff-c99a-4752-9fc1-ed3ebd382f40` (stage 1) |
| Supersedes | nothing; extends [ARCHITECTURE.md](ARCHITECTURE.md), [storage-contract.md](storage-contract.md), [recovery-contract.md](recovery-contract.md) |

A review PASS, a leaf status or an earlier plan approval is **not** acceptance of this
ADR. Changing this file changes its hash in the root plan and re-opens approval.

## Context

Evidence is in [architecture-system-map.md](architecture-system-map.md) and
[architecture-baseline.md](architecture-baseline.md). The decisive facts:

1. Cretli is one Node process (Express + `ws`) with 52 route files, ~15 WS handlers
   and an MCP bridge. Persistence is mixed: SQLite for delegations (schema 4) and
   recovery (schema 3), JSON documents for chats, history, todos and most
   configuration, JSONL for usage and audit.
2. The dominant measurable cost is **copying and scanning whole stores**: `loadChats()`
   returns a full copy of the chat list on each call and appears 135 times as a textual
   occurrence (static scan, includes the definition); per-row scope checks that called
   it are the suspected mechanism behind an earlier, **unverified** orientation figure
   (12.85 s → 279 ms, not reproduced by the stage-1 micro-benchmark; see baseline §4.1),
   which the request-local index (snapshot `065f3d5`) mitigates for the delegation
   routes only.
3. 807 synchronous fs call sites, 27 synchronous child-process sites, 7 `Atomics.wait`
   sites and 73 `DatabaseSync` references exist on code paths that can run on the
   event-loop thread. They are **candidate sites**, not measured blocking: per-site
   attribution is stage 6 work.
4. Two other programs already own large parts of the answer: storage `cf4fed89`
   (A2–A6: backend, history protocol, metadata migration) plus backup project `68f1c312`
   (B4 `09f85444`: offline backup/restore, a prerequisite of A3b) and recovery
   `53efd61e` (R1–R20: lifecycle, owner fencing, durable queues, resume). Their
   contracts are binding and are **not** modified by this ADR.

## Decision

D1. **Modular monolith, no new deployment units.** Keep one process and the existing
Express/`ws`/MCP stack. Introduce explicit domain modules behind commands and queries;
no microservices, no framework rewrite. Domains: chats/history; runs/delegations/
recovery; todos/workspaces/Watcher; settings/auth/widgets; usage/notifications;
harness integrations; tools (Files, Terminal, Browser).

D2. **Persistence profile = local single-writer, separate from routing.**
Every store has exactly one writer module (the registry row `domainOwner`). The
optional SDK multi-instance mode ([MULTI-INSTANCE.md](MULTI-INSTANCE.md): Redis, sticky
cookie, owner instance writes history, non-owner serves a read-only stub) is
**preserved unchanged**; this program neither extends nor removes it and adds no
competing writer. Regression checks for it are listed in the DAG (vertical V10).

D3. **SQLite WAL is local-disk, single-host only.** WAL requires shared memory on one
host and is not supported on network filesystems; the ADR therefore does *not* assume
safe multi-writer or WAL on shared/NFS data directories. Multi-instance deployments
that share a data directory keep today's guarantees (owner-instance history writes);
any variant beyond [storage-contract.md](storage-contract.md) needs a separate human
decision and the affected vertical stays **no-go** until then.

D4. **Transport → validation/auth → command/query → adapter.** Transports (HTTP, WS,
MCP) stay thin: they validate, authorize with their own scope policy (widget
installation, read-only modes, MCP capability codes) and call a domain command/query.
They do not scan files, duplicate business rules or emit durable success before the
commit. Policy differences between transports remain intentional.

D5. **Bounded reads.** Views read projections: indexed get-by-id, keyset or `seq`
pagination, counters and aggregates — not full-store copies. Caches carry key, scope,
limit, revision and invalidation and are never a second source of truth. Stage 3
implements this for the chat catalog first (cost driver C1). **Frozen by human decision,
2026-10-17:** API list/history page ≤ 100 rows and ≤ 128 KiB, any non-export API response
≤ 1 MiB, global DOM ≤ 5 000 nodes / ≤ 300 rendered rows — exactly as in baseline §5; they
change only by a human decision. Stage 4 applies the API caps to the list sync delta.

D6. **Event-loop discipline.** The main loop does transport and short commands.
Profiled long data/CPU work goes to workers with bounded queues, backpressure and
deadlines; the history SQLite worker is delivered by storage A2/A3a. No new
`Atomics.wait`; the seven existing sites are inventoried and assigned an owner (map §5,
DAG V6); removal happens only after measurement and only through the owning project.
No per-operation worker migration without a profile.

D7. **One incremental client state model** (indexes by entity id, revision-based
selectors/subscriptions, batching per frame) feeding Lit components and virtualized
lists; ephemeral streaming/presence state stays separate from persisted history.
Existing Lit/tokens/i18n rules apply; no competing UI rewrite.

D8. **One sync contract** (scope, generation/epoch/revision, ordering, idempotency,
dedupe, deltas, gap detection, controlled resync). History protocol, receipts and
chat epochs belong to A3a (`aadeac30`); this program consumes its API after that gate.
After the v2 cutover, v1 and missing-generation/producer writes are rejected and
unsent content is kept for explicit reconciliation (storage-contract); a read
compatibility window is not consent to legacy writes.

D9. **Lifecycle through existing contracts.** Start/cancel/Stop/terminal/shutdown/
recovery follow `docs/recovery-contract.md` and owners R1–R20. Subprocess lifetime
uses the existing `lib/child-process-registry.js` and the "Child process lifecycle"
section of ARCHITECTURE.md — no second registry, supervisor or sweeper.

D10. **Observability is part of the architecture.** Correlation ids without secrets;
timings per transport/domain/storage/worker/UI; queue depth/age; event-loop lag at
1 ms resolution; rows/bytes/refetch counts. Diagnostics must not scan stores or log
user content.

## Ownership decisions to confirm in the matrix

- `lib/persist/chat-history-revisions.js` today is an in-memory `Map` revision index
  for pull sync (header comment). **Proposed owner: A3a (`aadeac30`)** as the history
  protocol producer; this program only consumes it. Not an existing registry entry.
- The request-local chat index (delegation routes) is a baseline dependency, not a
  design: it belongs to vertical V0 and is superseded by V1.

## Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| Microservices / separate data service | rejected | Operational cost, breaks local single-user install and the multi-instance contract; the measured costs are in-process copies, not process boundaries. |
| Full SQLite for everything now | rejected | Storage `cf4fed89` already decided scope (history first, then metadata); unconditional rewrite violates its gates and recovery rollback rules. |
| Keep JSON, only add caches | rejected as sole strategy | Caches without revision/invalidation recreate hidden second sources of truth (C1 is itself a cache that copies). Allowed as a bounded projection in V1. |
| Worker threads for all I/O | rejected | Unmeasured; storage gate already shows worker only where it wins ≥5 ms p99. |
| Modular monolith + projections + worker only where profiled | **chosen** | Smallest change that addresses measured cost and respects existing owners. |

## Consequences

- Stages 2–8 become verticals with explicit contracts, budgets, rollback and go/no-go
  ([architecture-vertical-dag.md](architecture-vertical-dag.md)); none starts before
  its contract is frozen and the root plan version is approved by a human in the UI.
- Some verticals are **blocked by other programs** (A3a history, A3b metadata, R13/R15
  UI and scheduler). They are not marked done here.
- Unresolved/open: dependency-cycle report tooling is absent; central timer/cache
  registry is absent; no 500/5000/20000-chat HTTP/E2E fixture exists yet (only the
  micro-benchmark in the baseline). These are stage 2/3/8 deliverables.

## Rollback of this ADR

The ADR is documentation; reverting it changes no runtime. Each vertical carries its
own rollback (DAG column).
