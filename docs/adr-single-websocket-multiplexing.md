# ADR: one multiplexed WebSocket per client instead of one socket per open chat

Status: **proposed — recommendation: do not implement now** (measured below; revisit triggers at the end).
Scope of this document: analysis and measurement only. No protocol change ships with it.

## Context

The browser opens one WebSocket per open chat (`/ws-agent-sdk`, `app_front/features/chat/chatTransport.js`),
plus one chat-list/presence socket (`subscribeChatListUpdates`, `lib/chat-list-updates.js`) and per-panel
sockets (terminal, tasks, logs). Because browsers and the server treat concurrent handshakes as a scarce
resource, the client limits parallel handshakes with a connect slot
(`CHAT_WS_MAX_CONCURRENT_CONNECTS = 3`, mobile `1`; background reconnects in batches of 2 every 400 ms,
mobile 1 every 900 ms; `app_front/config.js`, `chatWsReconnectPolicy.js`). The question: should every chat of a
client ride on one socket with per-chat frames?

## Measurement: 20 open chats

Method: throwaway benchmark (not committed; loopback, bare `ws`, server in a child process, no TLS/proxy, Node
v22), 20 chats, a 2 KB `hello` per chat, then a burst of 4 000 small events spread over the 20 chats. Single
run per mode; these are order-of-magnitude numbers, not a gate.

| Metric (20 chats) | Socket per chat | One multiplexed socket |
| --- | ---: | ---: |
| Server sockets / handles | 20 / 20 | 1 / 1 |
| Server RSS delta after connect | 0.66 MB | 0.44 MB |
| Server heap delta | 0.92 MB | 0.50 MB |
| Time to have all 20 chats `hello`-ed (serial, no slot limit) | 20.7 ms | 6.2 ms |
| Mean per-chat attach | 1.03 ms | 0.19 ms |
| Delivery of 4 000 events | 27 ms | 22.5 ms |
| Protocol keepalive pings per minute (`WS_KEEPALIVE_INTERVAL_MS` = 30 s) | 40 | 2 |

Cost that the loopback run does not show but the client policy implies (computed from the constants above, not
measured): re-attaching 20 chats after a reconnect takes 3 immediately + 17 in batches of 2 every 400 ms ≈ 3.6 s
on desktop, and 1 + 19 batches of 1 every 900 ms ≈ 17 s on mobile, before network RTT (a TLS WebSocket
handshake costs 2–3 RTT, so at 150 ms RTT the serial mobile path is dominated by it). A single socket replaces
that with one handshake plus 20 `hello` frames.

Reading: the server-side saving at 20 chats is small (< 1 MB, tens of ms). The user-visible gain is the
reconnect/attach latency on mobile and on a restart, which today is bounded by the slot policy rather than by
server capacity.

## Decision drivers

1. Reconnect time with many open chats (mobile worst case ≈ 17 s at 20 chats).
2. Keepalive and handshake load growing linearly with open chats.
3. Risk: every chat's ordering/replay/backpressure logic is built around one socket per chat
   (`sdk-ws-handshake.ts`, `sdk-ws-transport.ts`, `cursor-agent-sdk-ws.ts`, the client `chatTransport.js`).

## Protocol sketch (if it is ever built)

Envelope: `{ v: 3, ch: "<chatId>", seq: <per-chat monotonically increasing>, type, ... }`. Control frames use
`ch: null` (`attach`, `detach`, `ping`, `credit`).

- **Per-chat frame protocol.** `attach {ch, lastSeq}` replaces the per-socket `hello`; the server answers with
  the existing `hello`/`replayBatch*` frames tagged with `ch`. `detach {ch}` releases the chat without closing the
  socket. Existing payload types stay unchanged inside the envelope, so handlers are reused per chat.
- **Ordering.** Per-chat order is the contract; there is no cross-chat order. `seq` is per chat, gap detection
  and replay stay exactly as today (the client resumes with `lastSeq`). One TCP stream gives per-chat order for
  free as long as the server enqueues a chat's frames in order.
- **Backpressure.** Today the threshold is per socket (`WS_BACKPRESSURE_THRESHOLD_BYTES` = 512 KiB, critical
  frames always sent, normal frames dropped to replay). On one socket a noisy chat would starve the others, so
  it needs per-chat credit: the server tracks bytes in flight per `ch` (cap e.g. 128 KiB), drops/queues only that
  chat's normal frames, and keeps critical frames (`SDK_WS_CRITICAL_BROADCAST_TYPES`) flowing. The socket-level
  `bufferedAmount` check remains the outer guard. A fair scheduler (round-robin per chat) is required so a replay
  of one chat (`REPLAY_BATCH_SIZE`) does not block the rest.
- **Backward compatibility.** Negotiated by subprotocol/query flag on a new path (`/ws-agent-mux`); the old
  `/ws-agent-sdk` stays served unchanged for widgets, older cached PWA shells and external clients for at least
  two releases. The server speaks both and routes both into the same per-chat room code. Widgets
  (`cretli-widget` subprotocol, per-installation allowlists) keep the per-chat socket because their auth scope is
  per chat.
- **Client migration plan.** (1) Server mux endpoint behind a flag, with per-chat credit and tests that replay
  the existing per-chat contract tests through the envelope. (2) Client transport adapter exposing today's
  `chat.ws` surface per chat on top of the shared socket, so `chatTransport.js` callers do not change.
  (3) Roll out desktop first, mobile after; kill-switch setting to fall back to per-chat sockets. (4) Remove the
  connect slot only after the mux is the default, and keep it for the legacy path.
- **Failure model.** One socket failing now drops all chats at once: reconnect must re-attach every open chat
  from its `lastSeq` (already idempotent), and the server must treat a half-open mux socket by the existing
  keepalive (30 s ping, 2 misses) — the blast radius of a stall grows from one chat to all, which is the main
  new risk.

## Options

| Option | Effect | Cost / risk |
| --- | --- | --- |
| A. Full multiplexing (this ADR) | 1 socket, ~0.2 ms attach per chat, 2 pings/min | New protocol, per-chat credit and fair scheduling, dual-stack period, larger blast radius, widgets stay on the old path |
| B. Lazy attach (only the active chat plus recently active ones hold a socket; the rest rely on presence + HTTP history, which already exists) | Cuts concurrent sockets and the mobile re-attach wall without a protocol change | Client policy only; a chat that streams in the background must be promoted to a socket |
| C. Status quo | None | Mobile reconnect with many open chats stays slot-bound |

## Recommendation: **do not do A now**

Justification:

- The measured server-side gain at 20 chats is under 1 MB and a few tens of milliseconds; keepalive load of 40
  pings/min is negligible. Capacity is not the problem.
- The real cost (reconnect wall time on mobile) is a client scheduling problem and is addressed more cheaply by
  option B, which needs no protocol change, no dual stack and does not enlarge the failure blast radius.
- A is a cross-cutting change to ordering, replay and backpressure of the most critical path of the product,
  with a long compatibility tail (cached PWA shells, widgets). The risk is out of proportion to the gain at the
  chat counts people actually keep open.

Revisit A when at least one holds: typical clients keep **> 50** chats attached; measured mobile
re-attach after restart exceeds **10 s** with option B in place; the server hits a socket/handle ceiling
(file descriptors, proxy connection limits) in production; or a feature needs cross-chat server push beyond what
the chat-list/presence socket already carries.

## Follow-up

- Evaluate option B as a separate leaf (client-only, behind a setting) and re-measure with real TLS on a mobile
  profile before deciding on A.
- If A is accepted later, add the envelope contract to `docs/ARCHITECTURE.md` and a performance budget
  (attach p95, per-chat credit fairness) to `tests/perf-budget-*.test.js`.
