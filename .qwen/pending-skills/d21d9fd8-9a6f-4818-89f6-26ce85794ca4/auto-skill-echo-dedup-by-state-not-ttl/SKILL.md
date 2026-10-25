---
name: echo-dedup-by-state-not-ttl
description: Suppress a redundant archive/restore (or any) echo frame by matching it against local list STATE instead of a wall-clock TTL window — used when a delegated review's suggested fix ("keep suppression until TTL / a post-action window") directly contradicts an explicit task clause forbidding an arbitrary TTL that would swallow a genuine independent change of the same id.
source: auto-skill
extracted_at: '2026-10-05T19:54:04.906Z'
---

# Recognize your own redundant echo by state, not by a time window

Trigger: a Cretli `implement` (or any) round where the goal is "one user action → at most one
full refetch", the extra fetch is caused by a server-pushed echo frame that can arrive AFTER the
action's own reload completes, and the `[TASK]` forbids solving it with a plain TTL.

Concrete origin (2026-10-05, `133d6d69`): clicking archive/restore/settled-group must issue
**max 1** `GET /api/chats`. The `chatsChanged reason=archive|restore` echo can reach the client
socket *after* `requestArchiveChat`'s `finally` calls `guard.end()`, which deletes the suppression
entry → live-sync `schedule()` fires a 2nd full GET (and that 2nd GET runs with
`includeArchived = isSidebarArchiveSectionOpen()`, potentially `false`, clobbering the archived
subtree the explicit `includeArchived:true` reload just fetched).

## The move that matters: the reviewer's proposed fix can be the wrong fix
- The review's "Do naprawy" said *"keep suppression until the TTL expires (or an equivalent
  post-reload window)"*. The `[TASK]` said verbatim **"Nie rozwiązuj przez arbitralny TTL
  tłumiący niezależne archive tego samego id; potrzebne rozpoznanie własnego echa/stanowej
  ramki"** — a time window would also swallow a genuinely independent archive/restore of the SAME
  chat id. Treat the review's suggested mechanism as a hypothesis, exactly like the finding text:
  **adjudicate it against every `[TASK]` clause before coding.** When they conflict, the task wins.
- Implement an equivalent-but-different mechanism that honors both, and put the substitution + the
  exact task sentence under **Odchylenia** so the parent sees you deliberately did not follow the
  reviewer's recipe.

## Discriminate by state when the frame carries no state
- Verify what the echo frame actually contains. Here the server broadcast
  (`lib/persist/chats-persist.js` → `updateChat`, broadcast BEFORE `res.json`;
  `lib/chat-list-updates.js` → `broadcastChatListChanged`) sends **only** `{type, reason, chatId}` —
  no row content (no `archivedAt`). So you cannot tell "my trailing echo" from "an independent
  same-id change" by the payload. The discriminator is the CURRENT local list:
  - `archive` → redundant iff the row exists AND reflects archived (`archivedAt` truthy).
  - `restore` → redundant iff the row exists AND reflects live (`archivedAt` empty).
  - **row absent → return false** (do NOT suppress): conservative, so an unknown or independent
    change still reloads. This is what preserves independent changes with zero wall-clock window.
- Check state FIRST, then fall back to the in-flight `begin`..`end` TTL. The TTL still covers the
  echo that arrives *during* the HTTP round trip, before the local stamp; the state check covers
  the echo that arrives *after* `end()`. Together they are exhaustive; neither alone suffices, and
  the TTL is never widened past the round trip (so it can't swallow a later independent change).

## Wiring that keeps existing behavior byte-identical
- Expose the discriminator as an **options-gated predicate defaulting to `() => false`**
  (`createChatListExplicitReloadGuard({ isChatStateAlreadyApplied })`). Existing unit tests that
  pass no predicate — including ones asserting suppression is `false` after `end()` — stay green.
  **Do not invert those assertions**; echo recognition only activates where the caller supplies a
  list reader. The new behavior being opt-in via an option is what makes the change blast-radius-safe.
- The wired predicate closes over the live list array. Before relying on it, confirm the reload
  **commits by mutating that same array in place** (`chats.length = 0; nextChats.forEach(c =>
  chats.push(c))`), not by reassigning a binding — otherwise the closure reads a stale array.

## Proving the bite when a plain-assert script aborts early
- A plain-assert `tests/<file>.test.js` stops at the FIRST failing assertion, so the guard-level
  block that fails pre-fix masks the controller+liveSync integration blocks that would show the
  real "2 GET not 1" signature. Pre-fix red alone under-proves it.
- Fix: with the final tests in place, temporarily neuter the new branch
  (`if (false && isChatStateAlreadyApplied(...) === true)` + a unique sentinel), run a throwaway
  `/tmp/*.mjs` probe that imports the REAL guard/liveSync/controller by absolute path and prints
  the observable `getChats` count after the post-`end()` echo — neutered → `2` (the defect),
  restored → `1`. Then restore, grep the sentinel (exit 1), `rm -rf` the scratch (never under
  `tests/` — it would be globbed into `npm test`).
- The probe's `getChats` stub must return a **fresh clone per call** (`snapshot.map(c => ({...c}))`)
  so the controller's in-place rebuild updates the array the predicate reads; reuse-of-one-object
  hides the second-fetch symptom.

## Reusable shape
Any "coalesce my own action's echo with the reload I already did" problem (sidebar lists, resource
panels, notification inboxes) fits this: prefer **state-idempotence recognition** over a time
window whenever (a) the action's own reload has already applied the change locally, and (b) an
independent change of the same id must still refresh. A TTL-only guard is the wrong answer whenever
the brief calls out "don't suppress independent same-id changes".
