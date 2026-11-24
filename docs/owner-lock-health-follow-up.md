# Owner-lock and health follow-up (2026-11-22)

The V1 chat-page and V9 owner-lock follow-up enforces the frozen 100-row / 128 KiB
chat-page budget and removes the socket probe from synchronous lock acquisition.

`isStoredOwnerLive(meta)` uses PID existence and, where available, process start
time. A missing/invalid metadata file refuses takeover; a live PID with unavailable
start time remains live. A different start time identifies PID reuse. A dead PID
can be reclaimed even when its Unix socket file remains on disk. The asynchronous
`isLockSocketLive` helper is diagnostic only: connect succeeds, error or an 80 ms
timer fails, and every created socket is destroyed with its error listener retained.
The stall profiler awaits this probe; its historical saved measurements are not
regenerated or presented as current results.

`GET /api/chats/page` keeps ordinary responses unchanged. Oversized pages return an
ordered prefix with a cursor after the last included original row. A row that
cannot fit alone is reduced to id, timestamps, workspace fields, archived timestamp
and a title clipped to 256 UTF-16 code units, marked `truncated: true`. Summaries,
execution paths and other optional fields are omitted; the existing single-chat
read retains the full record. Oversized identity fields or metadata produce a
bounded HTTP 413 `CHAT_PAGE_TOO_LARGE` response. Both default and `view=list` bodies
are checked including cursors, sync tokens, archive counts and linked-chat metadata.
Persisted title/path/session strings have no universal maximum, so tests include
large strings and a multi-MiB record instead of relying on assumed field bounds.
All three paging layers share `CHAT_PAGE_MAX_LIMIT = 100`; invalid limits retain
their existing default (50), and `readChatCatalog` follows all continuation cursors.
The frontend page API passes the caller's limit through; the chat-list consumer
uses bounded pages and continuation cursors, with no >100-row request to change.

O2 remains an **open human decision**. Health sampling stays at **20 ms**, including
its existing pinning test. The V9 **1 ms target remains unmet**. As recorded in
[server diagnostics](server-diagnostics.md), 1 ms measured +1.398 percentage points
of idle CPU and failed the HTTP noise check, against the <1% of one core adoption
rule. A human must still decide whether to accept that cost or revise the V9 target;
this follow-up does neither.
