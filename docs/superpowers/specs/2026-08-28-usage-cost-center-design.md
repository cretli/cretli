# Usage cost center — design

Cretli talks to several paid AI surfaces (OpenAI Realtime / TTS / STT, Gemini Live,
Azure Speech, OpenRouter, Cursor SDK, OpenCode). Today only the **voice Live session**
estimates USD, in the browser, and forgets it when the panel closes. Chat meters
measure **context window fill**, not money.

This spec is the single ledger that every paid call reports into.

## Goal

One server-side center prices tokens (and speech characters / minutes), stores them,
and answers “what did this instance spend today / this month, by provider and feature”.

## Non-goals (v1)

- Syncing provider invoices or Cursor dashboard billing.
- Replacing the chat context ring (`lib/sdk/sdk-context-advisory.js`).
- Multi-user / per-login wallets (one Cretli process = one ledger).
- Exact Cursor SDK USD (Cursor does not expose list prices). Record **tokens**, `usd: null`.
- OpenCode USD (no usage events). Skip until a usage event exists; do not invent chars/4 money.

## Source of truth

**Server** (`lib/usage/` + `data/usage/`). The browser never decides the price.
The browser may **report raw token counts** only when the provider socket is
browser-direct (OpenAI Realtime). Gemini Live already flows through
`lib/voice/gemini-live-relay.js` — record there, do not double-count from the client.

## Canonical event

```ts
{
  id: string,              // uuid
  at: string,              // ISO time
  provider: 'openai' | 'google' | 'azure' | 'openrouter' | 'cursor',
  feature: 'voice-live' | 'voice-tts' | 'voice-stt' | 'chat' | 'other',
  model: string,
  workspaceFile?: string,
  chatId?: string,
  tokens: {
    textInput: number,
    textOutput: number,
    audioInput: number,
    audioOutput: number,
    cachedInput: number,
    reasoning: number
  },
  characters?: number,     // TTS / Azure text
  audioSeconds?: number,   // STT duration
  usd: number | null,      // null = tokens known, price unknown
  estimated: boolean,      // true if quantities were inferred
  source: 'server' | 'client'
}
```

`priceUsage(event)` fills `usd` from `lib/usage/usage-rates.js` (USD per million
tokens / per million characters / per minute). Longest model-prefix wins, same
idea as `app_front/features/voice/voiceCost.js`.

## Persist

Gitignored `data/usage/YYYY-MM-DD.jsonl` — one JSON object per line, append-only.
Daily files keep reads small. Never commit this directory.

## API

| Method | Path | Role |
|--------|------|------|
| GET | `/api/usage/summary?from=&to=` | Totals + breakdown by provider / feature / day |
| POST | `/api/usage/events` | Client-reported **raw** usage (OpenAI Realtime). Server normalizes and prices. Rejects `usd` from the client. |

Auth: same `requireAuth` as the rest of `/api/*`.

## Who records

| Surface | Where | Adapter |
|---------|-------|---------|
| Gemini Live | `gemini-live-relay.js` on upstream `usageMetadata` (delta vs last) | `fromGeminiLiveUsage` |
| OpenAI Realtime | browser `response.done` → POST `/api/usage/events` | `fromOpenAiRealtimeUsage` |
| OpenAI TTS | `POST /api/voice/speak` after success | characters × model |
| OpenAI STT | `POST /api/voice/transcribe` after success | audio seconds |
| Azure Speech | same speak/transcribe Azure branches | characters or seconds |
| OpenRouter | last `usage` chunk in the harness | `fromOpenRouterUsage` |
| Cursor SDK | `usage` events in `cursor-agent-sdk-ws.js` | tokens only, `usd: null` |

Voice panel keep-alive meter stays, but it **must** call `priceUsage` from
`lib/usage/usage-rates.js` (webpack already imports `../lib/*`). Session warn/cap
($2 / $5) stay local; they are a guardrail, not the ledger.

## UI

New Settings tab **Usage** (`data-settings-tab="usage"`):

- Today and this calendar month (USD + token totals).
- Rows: provider × feature.
- Hint: “Approximate. Not an invoice.”
- `usd: null` rows show tokens and “—”.

No new top-level app tab. Voice panel cost figure stays as the live session total.

## Guardrails

- Never log or return API keys.
- Client cannot set `usd` or `source: 'server'`.
- Estimates are labeled `estimated: true`.
- Context meter stays a separate system.
