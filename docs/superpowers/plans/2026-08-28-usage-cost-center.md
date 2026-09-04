# Usage cost center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One server-side ledger prices and stores usage from every Cretli AI surface (voice, chat harnesses) and shows today/month totals in Settings.

**Architecture:** Canonical events in `lib/usage/`, priced from one rate table, appended as daily JSONL under gitignored `data/usage/`. Providers never write USD themselves. The browser may only POST raw OpenAI Realtime token counts. Gemini Live is recorded on the existing WS relay. Voice session warn/cap stays in the panel but uses the same `priceUsage`.

**Tech Stack:** Node.js (Express), existing `writeJsonAtomic` / `resolveDataPath`, webpack SPA (`app_front/`), Lit/settings HTML, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-28-usage-cost-center-design.md`

## Global Constraints

- English comments and docs (Cretli OSS). Polish UI only via `app_front/i18n/pl.js`.
- Do not commit `data/` or API keys.
- Do not commit unless the user explicitly asks (user rule). Treat “Commit” steps as optional.
- Guard clauses; no `any`; JSDoc on public functions.
- Do not replace the chat context meter (`lib/sdk/sdk-context-advisory.js`).
- Cursor SDK: tokens only, `usd: null`. OpenCode: skip money until real usage exists.
- Client POST must not accept `usd` or `source`.
- One export per new file where practical; keep files small.

## File map

| File | Responsibility |
|------|----------------|
| `lib/usage/usage-event.js` | Event shape, empty token bag, `createUsageEvent` |
| `lib/usage/usage-rates.js` | Rate table + `priceUsage` + `formatUsd` |
| `lib/usage/usage-normalize.js` | Provider payload → token bag |
| `lib/persist/usage-persist.js` | Append/read daily JSONL |
| `lib/usage/usage-ledger.js` | `recordUsage` + `summarizeUsage` |
| `lib/routes/usage-routes.js` | GET summary, POST client events |
| `server.js` | `registerUsageRoutes(app)` |
| `lib/voice/gemini-live-relay.js` | Record Gemini `usageMetadata` |
| `lib/routes/voice-routes.js` | Record TTS/STT after success |
| OpenRouter / SDK rooms | Record after provider usage |
| `app_front/features/voice/voiceCost.js` | Use `priceUsage`; POST Realtime deltas |
| `public/index.html` + i18n + settings JS | Usage tab |
| `docs/ARCHITECTURE.md` | Short ledger section |
| `tests/usage-*.test.js` | Unit tests |

---

### Task 1: Canonical event + rates

**Files:**
- Create: `lib/usage/usage-event.js`
- Create: `lib/usage/usage-rates.js`
- Test: `tests/usage-rates.test.js`

**Interfaces:**
- Produces: `createUsageEvent(partial)`, `emptyUsageTokens()`, `priceUsage(event)`, `formatUsd(usd)`, `USAGE_FEATURES`, `USAGE_PROVIDERS`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import { formatUsd, priceUsage } from '../lib/usage/usage-rates.js';

test('prices OpenAI realtime audio at the flagship rate', () => {
  const event = createUsageEvent({
    provider: 'openai',
    feature: 'voice-live',
    model: 'gpt-realtime-2.1',
    tokens: { audioInput: 1_000_000, audioOutput: 0, textInput: 0, textOutput: 0, cachedInput: 0, reasoning: 0 },
  });
  const priced = priceUsage(event);
  assert.equal(priced.usd, 32);
});

test('prices Gemini live audio cheaper than OpenAI flagship', () => {
  const event = createUsageEvent({
    provider: 'google',
    feature: 'voice-live',
    model: 'gemini-3.1-flash-live-preview',
    tokens: { audioInput: 1_000_000, audioOutput: 0, textInput: 0, textOutput: 0, cachedInput: 0, reasoning: 0 },
  });
  assert.ok(priceUsage(event).usd < 10);
});

test('leaves Cursor SDK unpriced', () => {
  const event = createUsageEvent({
    provider: 'cursor',
    feature: 'chat',
    model: 'composer-2',
    tokens: { textInput: 1000, textOutput: 200, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
  });
  assert.equal(priceUsage(event).usd, null);
});

test('formats tiny amounts', () => {
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.2), '$1.20');
  assert.equal(formatUsd(null), '—');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/usage-rates.test.js`

Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `lib/usage/usage-event.js`

- [ ] **Step 3: Write `lib/usage/usage-event.js`**

```js
import { randomUUID } from 'node:crypto';

export const USAGE_PROVIDERS = Object.freeze(['openai', 'google', 'azure', 'openrouter', 'cursor', 'other']);
export const USAGE_FEATURES = Object.freeze(['voice-live', 'voice-tts', 'voice-stt', 'chat', 'other']);

export function emptyUsageTokens() {
  return {
    textInput: 0,
    textOutput: 0,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 0,
    reasoning: 0,
  };
}

/**
 * @param {object} partial
 * @returns {object}
 */
export function createUsageEvent(partial = {}) {
  const tokens = { ...emptyUsageTokens(), ...(partial.tokens || {}) };
  for (const key of Object.keys(tokens)) {
    const value = Number(tokens[key]);
    tokens[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  const provider = USAGE_PROVIDERS.includes(partial.provider) ? partial.provider : 'other';
  const feature = USAGE_FEATURES.includes(partial.feature) ? partial.feature : 'other';
  return {
    id: String(partial.id || randomUUID()),
    at: String(partial.at || new Date().toISOString()),
    provider,
    feature,
    model: String(partial.model || '').trim(),
    workspaceFile: partial.workspaceFile ? String(partial.workspaceFile) : undefined,
    chatId: partial.chatId ? String(partial.chatId) : undefined,
    tokens,
    characters: Number.isFinite(Number(partial.characters)) ? Math.max(0, Number(partial.characters)) : 0,
    audioSeconds: Number.isFinite(Number(partial.audioSeconds)) ? Math.max(0, Number(partial.audioSeconds)) : 0,
    usd: null,
    estimated: partial.estimated === true,
    source: partial.source === 'client' ? 'client' : 'server',
  };
}
```

Unknown provider/feature fall back to `'other'`.

- [ ] **Step 4: Write `lib/usage/usage-rates.js`**

Copy the Live rates from `app_front/features/voice/voiceCost.js` (`RATES_USD_PER_MILLION`) and add:

```js
const TOKEN_RATES = {
  'gpt-realtime-2.1-mini': { textInput: 0.6, cachedInput: 0.06, audioInput: 10, textOutput: 2.4, audioOutput: 20 },
  'gpt-realtime-mini': { /* same as mini */ },
  'gpt-realtime': { textInput: 4, cachedInput: 0.4, audioInput: 32, textOutput: 24, audioOutput: 64 },
  gemini: { textInput: 0.5, cachedInput: 0.5, audioInput: 3, textOutput: 2, audioOutput: 12 },
};

const CHAR_RATES_PER_MILLION = {
  'gpt-4o-mini-tts': 15,
  'tts-1': 15,
  'tts-1-hd': 30,
  azure: 16,
};

const MINUTE_RATES = {
  'whisper-1': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  azure: 0.0167,
};

const UNPRICED_PROVIDERS = new Set(['cursor']);

export function priceUsage(event) {
  if (!event || UNPRICED_PROVIDERS.has(event.provider)) {
    return { ...event, usd: null };
  }
  const tokens = event.tokens || {};
  const tokenRates = resolveTokenRates(event.model, event.provider);
  let usd = 0;
  if (tokenRates) {
    usd +=
      (tokens.textInput * tokenRates.textInput +
        tokens.cachedInput * tokenRates.cachedInput +
        tokens.audioInput * tokenRates.audioInput +
        tokens.textOutput * tokenRates.textOutput +
        tokens.audioOutput * tokenRates.audioOutput) /
      1_000_000;
  }
  const chars = Number(event.characters) || 0;
  if (chars > 0) usd += (chars * resolveCharRate(event.model, event.provider)) / 1_000_000;
  const seconds = Number(event.audioSeconds) || 0;
  if (seconds > 0) usd += (seconds / 60) * resolveMinuteRate(event.model, event.provider);
  return { ...event, usd: Number(usd.toFixed(6)) };
}

export function formatUsd(usd) {
  if (usd == null || !Number.isFinite(Number(usd))) return '—';
  const value = Number(usd);
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}
```

`resolveTokenRates`: longest prefix match on `model.toLowerCase()`. If `provider === 'google'` and no prefix, use `gemini`. If no rates and no chars/seconds, `usd` stays `0` only when quantities are zero; if tokens > 0 but no rate, return `usd: null`.

- [ ] **Step 5: Run tests**

Run: `node --test tests/usage-rates.test.js`

Expected: PASS

- [ ] **Step 6: Commit (only if the user asks)**

```bash
# optional
```

---

### Task 2: Provider normalizers

**Files:**
- Create: `lib/usage/usage-normalize.js`
- Test: `tests/usage-normalize.test.js`

**Interfaces:**
- Consumes: `emptyUsageTokens()`
- Produces: `fromOpenAiRealtimeUsage(usage)`, `fromGeminiLiveUsage(usage, previousTokens)`, `fromOpenRouterUsage(usage)`, `fromSdkUsage(usage)`

- [ ] **Step 1: Write the failing test**

Reuse the `makeUsage` helper from `tests/voice-cost.test.js`. Assert:

- OpenAI 1M audio-in → `{ audioInput: 1_000_000, ...zeros }`
- Cached audio subtracted from audio-in (same as `voiceCost.addUsage`)
- Gemini cumulative `promptTokensDetails` / `candidatesTokensDetails` minus `previousTokens` yields a **delta**
- OpenRouter `{ prompt_tokens, completion_tokens }` → text in/out
- SDK `{ inputTokens, outputTokens, cacheReadTokens, reasoningTokens }` → text + cached + reasoning

- [ ] **Step 2: Run test — expect FAIL (module missing)**

Run: `node --test tests/usage-normalize.test.js`

- [ ] **Step 3: Implement adapters**

Move the arithmetic from `createVoiceCostTracker.addUsage` / `addGeminiUsage` into these functions. They return a `tokens` object only (no USD).

Gemini: `usageMetadata` is cumulative; `previousTokens` is the last **cumulative** snapshot stored on the relay connection, not the ledger total.

```js
export function fromGeminiLiveUsage(usage, previousTokens = emptyUsageTokens()) {
  const current = /* parse modalities AUDIO/TEXT */;
  return {
    textInput: Math.max(0, current.textInput - previousTokens.textInput),
    // ...
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test tests/usage-normalize.test.js tests/usage-rates.test.js`

- [ ] **Step 5: Commit (only if the user asks)**

---

### Task 3: Persist + ledger

**Files:**
- Create: `lib/persist/usage-persist.js`
- Create: `lib/usage/usage-ledger.js`
- Test: `tests/usage-ledger.test.js`

**Interfaces:**
- Consumes: `createUsageEvent`, `priceUsage`
- Produces: `appendUsageEvent(event, { dataDir })`, `readUsageEvents({ from, to, dataDir })`, `recordUsage(partial, { dataDir })`, `summarizeUsage(events)`

- [ ] **Step 1: Write the failing test**

Use `fs.mkdtempSync` for `dataDir`. Record two events (openai voice-live, google voice-live). Assert:

- Files exist at `{dataDir}/usage/YYYY-MM-DD.jsonl`
- `summarizeUsage` has `totalUsd`, `byProvider.openai`, `byFeature['voice-live']`, `byDay[date]`
- Cursor event with `usd: null` does not become `0` in `totalUsd` (sum only finite usd)
- `tokenTotals` still include Cursor tokens

```js
export function summarizeUsage(events) {
  const summary = {
    totalUsd: 0,
    estimatedUsd: 0,
    unpricedEvents: 0,
    tokens: emptyUsageTokens(),
    byProvider: {},
    byFeature: {},
    byDay: {},
  };
  for (const event of events) {
    if (Number.isFinite(event.usd)) summary.totalUsd += event.usd;
    else summary.unpricedEvents += 1;
    // add tokens, group keys...
  }
  summary.totalUsd = Number(summary.totalUsd.toFixed(6));
  return summary;
}
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `node --test tests/usage-ledger.test.js`

- [ ] **Step 3: Implement persist**

```js
// lib/persist/usage-persist.js
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';

export function usageDayPath(dataDir, isoDate) {
  const day = String(isoDate || '').slice(0, 10);
  return path.join(dataDir, 'usage', `${day}.jsonl`);
}

export function appendUsageEvent(event, { dataDir }) {
  const file = usageDayPath(dataDir, event.at);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

export function readUsageEvents({ from, to, dataDir }) {
  const dir = path.join(dataDir, 'usage');
  if (!existsSync(dir)) return [];
  // list YYYY-MM-DD.jsonl whose day is in [from, to], parse lines, skip corrupt lines
}
```

`recordUsage(partial, ctx)` = `createUsageEvent` → `priceUsage` → `appendUsageEvent` → return priced event.

Default `dataDir`: `resolveDataPath('')` parent — check `lib/runtime-paths.js`. Use `resolveDataPath('usage')` as the directory if that helper joins under `data/`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test tests/usage-ledger.test.js`

- [ ] **Step 5: Commit (only if the user asks)**

---

### Task 4: HTTP API

**Files:**
- Create: `lib/routes/usage-routes.js`
- Modify: `server.js` (import + `registerUsageRoutes(app)` next to `registerVoiceRoutes`)
- Test: `tests/usage-routes.test.js` (fake Express app, same pattern as `tests/voice-routes.test.js`)

**Interfaces:**
- Consumes: `recordUsage`, `readUsageEvents`, `summarizeUsage`
- Produces: `GET /api/usage/summary`, `POST /api/usage/events`

- [ ] **Step 1: Write route tests**

- GET with empty ledger → `{ ok: true, summary: { totalUsd: 0, ... } }`
- POST `{ provider: 'openai', feature: 'voice-live', model: 'gpt-realtime-2.1', usage: <realtime payload> }` → `ok: true`, `event.usd` set, `event.source === 'client'`
- POST `{ usd: 999 }` must **not** persist 999 — server prices
- POST missing provider → 400

Inject `dataDir` via `registerUsageRoutes(app, { dataDir })` so tests do not touch real `data/`.

- [ ] **Step 2: Run test — expect FAIL (route not registered)**

- [ ] **Step 3: Implement routes**

```js
export function registerUsageRoutes(app, ctx = {}) {
  app.get('/api/usage/summary', (req, res) => {
    const to = String(req.query.to || new Date().toISOString());
    const from = String(req.query.from || monthStartIso(to));
    const events = readUsageEvents({ from, to, dataDir: ctx.dataDir });
    return res.json({ ok: true, from, to, summary: summarizeUsage(events) });
  });

  app.post('/api/usage/events', (req, res) => {
    const body = req.body || {};
    if (body.usd != null) {
      return res.status(400).json({ ok: false, error: 'Client must not send usd' });
    }
    const tokens = fromOpenAiRealtimeUsage(body.usage || body.tokens);
    const event = recordUsage({
      provider: body.provider,
      feature: body.feature || 'voice-live',
      model: body.model,
      tokens,
      source: 'client',
      chatId: body.chatId,
      workspaceFile: body.workspaceFile,
    }, ctx);
    return res.json({ ok: true, event: { id: event.id, usd: event.usd, tokens: event.tokens } });
  });
}
```

In `server.js` after `registerVoiceRoutes(app)`:

```js
import { registerUsageRoutes } from './lib/routes/usage-routes.js';
registerUsageRoutes(app);
```

`requireAuth` already wraps `/api/*` — do not add a public exception.

- [ ] **Step 4: Run tests**

Run: `node --test tests/usage-routes.test.js tests/usage-ledger.test.js`

Expected: PASS

- [ ] **Step 5: Commit (only if the user asks)**

---

### Task 5: Server-side hooks (Gemini, TTS/STT)

**Files:**
- Modify: `lib/voice/gemini-live-relay.js` — parse upstream JSON, keep `lastGeminiTokens` per connection, `recordUsage({ provider: 'google', feature: 'voice-live', model, tokens: delta, source: 'server' })`
- Modify: `lib/routes/voice-routes.js` — after successful speak/transcribe, `recordUsage` with characters or `audioSeconds`
- Test: `tests/voice-gemini-relay.test.js` (extend) or `tests/usage-gemini-relay.test.js`
- Test: add one case in `tests/voice-routes.test.js` with mocked persist (or inject `recordUsage` via optional ctx to avoid writing `data/`)

**Interfaces:**
- Consumes: `fromGeminiLiveUsage`, `recordUsage`
- Produces: ledger rows for Live + speech

- [ ] **Step 1: Write a relay unit test**

If the current relay test only checks tickets, add `extractGeminiUsageDelta(payload, previous)` in `lib/usage/usage-normalize.js` (already have `fromGeminiLiveUsage`) and test that the relay **calls** a injected `onUsage` callback. Keep the relay KISS: optional `onUsage` parameter defaulting to `recordUsage`.

```js
export function handleGeminiLiveRelayConnection(client, ticket, hooks = {}) {
  const record = hooks.recordUsage || recordUsage;
  let lastTokens = emptyUsageTokens();
  // in upstream.on('message'):
  const payload = tryParseJson(data);
  if (payload?.usageMetadata) {
    const tokens = fromGeminiLiveUsage(payload.usageMetadata, lastTokens);
    lastTokens = /* cumulative parse, not delta */;
    record({
      provider: 'google',
      feature: 'voice-live',
      model: 'gemini-3.1-flash-live-preview',
      tokens,
      source: 'server',
    });
  }
}
```

Store **cumulative** snapshot for the next delta. `fromGeminiLiveUsage` already subtracts previous.

- [ ] **Step 2: TTS/STT**

After a 200 from OpenAI/Azure:

- speak: `characters: text.length`, `feature: 'voice-tts'`, model name used
- transcribe: `audioSeconds` from `req.body.durationSec` if present, else skip seconds and set `estimated: true` with `characters: 0` and do not invent duration

Do not fail the user request if `recordUsage` throws — `try/catch` and `appLogger` / `console.error`.

- [ ] **Step 3: Run**

Run: `node --test tests/voice-gemini-relay.test.js tests/voice-routes.test.js tests/usage-normalize.test.js`

Expected: PASS, no key material in logs

- [ ] **Step 4: Commit (only if the user asks)**

---

### Task 6: Chat harness hooks + Realtime client report

**Files:**
- Modify: `lib/agent-harness/openrouter-agent-loop.js` (the `for await (const chunk of streamOpenRouterChatCompletion)` loop) — keep the last `chunk.usage` and after the stream ends call `recordUsage({ provider: 'openrouter', feature: 'chat', model, tokens: fromOpenRouterUsage(usage) })`. Today `openrouter-client.js` parses `usage` but the loop drops it.
- Modify: `lib/sdk/cursor-agent-sdk-ws.js` near existing `room._lastUsagePayload` — on `event.type === 'usage'`, record **delta vs last recorded totals** (SDK usage is usually cumulative per turn; if it is a snapshot, store last and subtract)
- Modify: `app_front/features/voice/voiceCost.js` — `recompute()` uses `priceUsage`; `addUsage` also `POST /api/usage/events` (fire-and-forget)
- Modify: `app_front/api.js` — `postUsageEvent(payload)`
- Keep Gemini Live **client** from POSTing (server already recorded)

**Interfaces:**
- Consumes: `fromOpenRouterUsage`, `fromSdkUsage`, `priceUsage`, `createUsageEvent`
- Produces: chat + Realtime rows; voice panel number matches ledger rates

- [ ] **Step 1: Tests for SDK/OpenRouter normalize already exist — add ledger delta test**

If SDK sends full snapshots, `fromSdkUsage` returns absolute counts; ledger helper `deltaTokens(current, previous)` lives in `usage-normalize.js`.

- [ ] **Step 2: voiceCost**

```js
import { createUsageEvent } from '../../../lib/usage/usage-event.js';
import { priceUsage } from '../../../lib/usage/usage-rates.js';

function recompute() {
  const priced = priceUsage(createUsageEvent({
    provider: options.provider || (String(options.model).includes('gemini') ? 'google' : 'openai'),
    feature: 'voice-live',
    model: options.model,
    tokens,
  }));
  totalUsd = priced.usd || 0;
}
```

Existing `tests/voice-cost.test.js` must still pass — if flagship audio-in 1M is still $32, good. Update imports if `formatUsd` moves; **re-export** `formatUsd` from `voiceCost.js` so the panel does not break:

```js
export { formatUsd } from '../../../lib/usage/usage-rates.js';
```

Gemini session: do **not** POST (relay records). OpenAI session: POST after `addUsage`.

- [ ] **Step 3: Run**

Run: `node --test tests/voice-cost.test.js tests/usage-rates.test.js tests/usage-normalize.test.js`

Expected: PASS

- [ ] **Step 4: Commit (only if the user asks)**

---

### Task 7: Settings Usage tab

**Files:**
- Modify: `public/index.html` — tab button + section after Account (or before Account)
- Modify: `app_front/i18n/en.js` + `pl.js` — `settings.tabsUsage`, `usage.today`, `usage.month`, `usage.hint`, `usage.empty`, column labels
- Create: `app_front/features/usage/usageSettings.js` — `initUsageSettings()` loads GET `/api/usage/summary`
- Modify: `app_front/api.js` — `getUsageSummary({ from, to })`
- Modify: `app_front/App.js` — add `'usage'` to `SETTINGS_TABS` (around line 794) and in `applySettingsTab` call `refreshUsageSettings()` when `tabId === 'usage'`
- Modify: `docs/ARCHITECTURE.md` — short “Usage ledger” section (do not duplicate this whole plan)
- Test: `tests/i18n-dictionaries.test.js` (keys must exist in both locales)

**Interfaces:**
- Consumes: `GET /api/usage/summary`
- Produces: Settings → Usage table

- [ ] **Step 1: HTML skeleton**

```html
<button type="button" class="settings-tab" data-settings-tab="usage" role="tab" data-i18n="settings.tabsUsage">Usage</button>
```

```html
<section class="settings-section" data-settings-tab="usage" hidden>
  <h3 class="settings-section-title" data-i18n="usage.title">Usage and cost</h3>
  <p class="settings-hint" data-i18n="usage.hint">Approximate totals for this Cretli instance. Not a provider invoice.</p>
  <p id="usage-summary-period" class="settings-hint"></p>
  <p id="usage-summary-total" class="settings-hint"></p>
  <table id="usage-summary-table" class="settings-usage-table">
    <thead>
      <tr>
        <th data-i18n="usage.colProvider">Provider</th>
        <th data-i18n="usage.colFeature">Feature</th>
        <th data-i18n="usage.colUsd">USD</th>
        <th data-i18n="usage.colTokens">Tokens</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
</section>
```

Style with existing settings table/list classes if any; otherwise a few rules in `app_front/css/app.scss` using `var(--cr-*)`.

- [ ] **Step 2: `initUsageSettings`**

On tab show (or first open of settings), `getUsageSummary()` for the current month. Render rows from `summary.byProvider` × if you only have `byProvider` and `byFeature`, show two lists (KISS): **By provider** and **By feature**, plus the total.

Reload when the Usage tab is selected (same pattern as other lazy settings blocks).

- [ ] **Step 3: i18n test**

Run: `node --test tests/i18n-dictionaries.test.js`

Expected: PASS (keys in en and pl)

- [ ] **Step 4: Browser check**

Restart Cretli (`POST /api/dev-actions` `{ action: 'restart-server' }` or `npm run start:lan`). Open Settings → Usage. Empty state if no events. Trigger Gemini key test does **not** need to appear (models.list is free). Speak or Live will add rows after Task 5.

- [ ] **Step 5: Commit (only if the user asks)**

---

## Verification (whole system)

```bash
node --test tests/usage-rates.test.js tests/usage-normalize.test.js tests/usage-ledger.test.js tests/usage-routes.test.js tests/voice-cost.test.js tests/voice-routes.test.js tests/voice-gemini-relay.test.js tests/i18n-dictionaries.test.js
```

Expected: all PASS.

Manual: new Gemini Live session → Settings → Usage shows `google` / `voice-live`. OpenAI speak → `openai` / `voice-tts`.

## Out of scope leftovers (do not do in this plan)

- OpenCode pricing
- Cursor USD
- Daily email / spend email
- Changing default Live warn/cap
- Merging context-meter UI into this tab
