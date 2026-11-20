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

## Archive and restore

The operator explicitly approves each completed assessment. Assessments expire
after 24 hours and can be used once. Immediately before archiving, the service
rechecks eligibility and compares the family metadata and saved history with the
assessment snapshot. A changed conversation needs a new assessment. The existing
store archives the fork subtree in one operation and enforces its live-run guard.
These checks use the existing stores; they are not a transaction spanning history,
TODOs and delegations, which can change independently.

Restore checks that the recorded family still exists, remains archived under the
same archive timestamp and has no new descendants, then uses the existing subtree
restore operation. A family changed by other archive actions requires manual
inspection in the sidebar.

## Journal and API

`data/chat-archivist.json` stores the latest 500 assessments, archive attempts and
restores with timestamps, chat titles, member IDs and reasons. It does not store
the excerpts or credentials. An archive intent is persisted before the archive
write; an interrupted operation remains pending for manual inspection. Failed
archive writes are recorded. A JSON export includes the currently listed
candidates and retained journal entries. Existing archive mechanisms do not
write into this journal and older entries beyond the cap are not retained.

Routes require a signed-in application session; widgets and MCP integrations
are denied. The HTTP server owns the service and serializes its mutations.

- `GET /api/chat-archivist?idleDays=7`: candidates and journal; no model call.
- `POST /api/chat-archivist/assess` with `{ chatId, idleDays? }`: one assessment.
- `POST /api/chat-archivist/archive` with `{ assessmentId, confirm: true }`.
- `POST /api/chat-archivist/restore` with `{ actionId }`.
