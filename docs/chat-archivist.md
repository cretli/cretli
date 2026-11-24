# Completion archivist

Settings → Chat and agents → Archiving contains a completion assessment panel.
Load the report, assess a candidate, then choose **Archive family** for an
assessment marked completed. Assessment alone never archives or resumes a chat.
The original idle auto-archive and technical retention jobs remain independent;
this feature does not add a new automatic sweep.

## Assessment

Candidates are unarchived conversations idle for at least seven days by default.
The report lists up to 100 oldest candidates across workspaces. Each assessment
checks the entire fork family with the shared archive policy, recovery registry,
delegation state, favorites and open TODO links in each member's own workspace.
Pinned, active, unreadable, oversized or partly archived families are refused.
Families are limited to ten chats.

One separate model request receives up to 20 recent user/assistant text records
per member, clipped to 3,000 characters per record, within a total 24,000-character
transcript budget. Tools, images and thinking are not sent. This is an excerpt,
not the complete conversation. The result is an advisory judgment about recorded
completion, not independent verification of repository state or task correctness.
Missing context must result in uncertainty. Unsupported history formats remain
uncertain rather than authorizing an archive.

The request reuses the configured auto-title HTTP provider/model. It consumes
that provider's quota, has a 90-second timeout and a 1,000-token output cap.
Subscription agent adapters are excluded; no source session or child chat is
started. Provider failures or malformed answers result in uncertainty. Completion
requires valid assistant-event references for every family member. The provider
and model are retained with successful assessments.

`mode: "idle"` is the default and uses `idleDays * DAY`. On-demand
`mode: "manual"` uses the shared 15-minute `CHAT_ARCHIVE_GRACE_MS`; all other
family gates still apply. Assessments retain `graceMs`, which subsequent archive
operations reuse; older assessments fall back to `idleDays * DAY`.

A `needs_action` result includes up to five `openItems` with `title` (120
characters) and `detail` (600 characters). Invalid entries are discarded without
changing the verdict; other verdicts carry an empty list. `refSeq` points to the
last assistant record in the root chat excerpt, or its history `headSeq` when
there is no assistant record.

## Archive and restore

The operator explicitly approves each completed assessment, or a needs_action
assessment after selecting open items to create as TODOs. Assessments expire
after 24 hours for a first archive action and can be used once. Immediately
before archiving, the service rechecks eligibility and compares the family metadata and saved history with the
assessment snapshot. A changed conversation needs a new assessment. The existing
store archives the fork subtree in one operation and enforces its live-run guard.
These checks use the existing stores; they are not a transaction spanning history,
TODOs and delegations, which can change independently.

Restore checks that the recorded family still exists, remains archived under the
same archive timestamp and has no new descendants, then uses the existing subtree
restore operation. A family changed by other archive actions requires manual
inspection in the sidebar.

## Follow-up TODOs and recovery

`archive-with-followups` accepts nonempty `items: [{ index, title }]`, where
`index` selects an assessment open item and `title` is an editable nonempty title
of at most 120 characters. Indices must be unique. Only `needs_action` qualifies.
Validation and the unchanged snapshot are checked before the first write. The
service freezes the selected indices, titles and original details in a
`kind: "followups"` journal action, creates `idea` TODOs in the root workspace,
and then archives the family. TODO bodies contain the detail and a
`cretli-ref chat=<chatId> seq=<refSeq>` reference. They are not linked to the
source chat, so they do not block its archive through the open-TODO gate.

Pending or failed actions resume with the same frozen payload; a changed payload
returns `followups_payload_mismatch` (409). Retries do not expire after 24 hours.
Each created TODO ID is journaled separately and skipped on retry. The deterministic
key `archivist:<assessmentId>:<index>` covers the crash window between TODO creation
and journaling its ID, only while that key remains among the store's latest
4,000 workspace idempotency entries. This is the boundary of the replay guarantee.
An already archived action returns the same record. Recovery detects an already
archived family before snapshot validation and retains its members and archive
timestamp. Otherwise it rechecks the snapshot; a changed chat fails with
`chat_changed`. Created TODOs remain, and failure responses include the action
and its recorded `todoIds`.

Restore accepts both `archive` and `followups` records with identical family and
timestamp checks. Restoring a family leaves the created TODOs intact.

## Journal and API

`data/chat-archivist.json` stores the latest 500 assessments, archive attempts and
restores with timestamps, chat titles, member IDs and reasons. It does not store
the excerpts or credentials. An archive intent is persisted before the archive
write; an interrupted plain archive remains pending for manual inspection.
Follow-up actions support the recovery described above. Failed
archive writes are recorded. A JSON export includes the currently listed
candidates and retained journal entries. Existing archive mechanisms do not
write into this journal and older entries beyond the cap are not retained.

Routes require a signed-in application session; widgets and MCP integrations
are denied. The HTTP server owns the service and serializes its mutations.

- `GET /api/chat-archivist?idleDays=7`: candidates and journal; no model call.
- `POST /api/chat-archivist/assess` with `{ chatId, mode?, idleDays? }`: one assessment.
- `POST /api/chat-archivist/archive` with `{ assessmentId, confirm: true }`.
- `POST /api/chat-archivist/archive-with-followups` with `{ assessmentId, items: [{ index, title }], confirm: true }`.
- `POST /api/chat-archivist/restore` with `{ actionId }`.
