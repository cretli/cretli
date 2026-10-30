# Chat retention

Technical chats pile up (Workspace Watcher cycles, merge and plan chats, delegation
and review children). Retention archives them after N idle days. It is an archive,
not a delete, and **disabled by default**.

## What qualifies

A chat is a candidate only if it is technical: its title starts with `[Watcher]`,
`[Merge]`, `[Todo plan]` or `[Scout]`, or it is a delegation child. Ordinary user
chats never qualify, however old they are. A candidate is skipped when it is
younger than `idleDays`, pinned or has a live run, is linked to an open (not done)
todo, has a non-terminal or slot-holding delegation, or its fork family contains
an ordinary chat. Skips are counted per reason in the report.

## Config (settings key `chatRetention`)

`enabled` (default `false`), `idleDays` (default `7`), `batchLimit` (default `50`).
When enabled, the hourly housekeeping job (`chat_retention`) applies one batch.

## API

- `GET /api/chat-retention`: config plus dry-run report (count, list, estimated bytes
  saved, skipped counts by reason). Nothing is written.
- `PATCH /api/chat-retention/config`: change the config.
- `POST /api/chat-retention/apply` with `{ "confirm": true, "limit"?: n }`: archive one
  batch. It uses the same plan as the dry-run, so the numbers match.
- `POST /api/chat-retention/restore` with `{ "chatId" }`: restore in one action (the
  same as `PATCH /api/chats/:id { archived: false }`).

Bytes saved are an estimate (size of the stored chat row).
