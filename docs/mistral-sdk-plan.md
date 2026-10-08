# Mistral AI SDK — risercz i plan implementacji

Dokument roboczy: dodanie nowego, wbudowanego harnessu `mistral` do Cretli.
Risercz: oficjalny SDK Mistral AI + aktualny stan API. Plan: dokładne miejsca w
kodzie, kontrakty, fazy wdrożenia, testy i ryzyka.

> Status: **plan** (nie zaimplementowano). Data riserczu: 2026-10-07.

---

## 0. TL;DR — rekomendacja

Mistral nie jest agentem CLI (jak `claude`, `codex`, `dsh`, `codebuddy`), tylko
**modelem LLM z tool callingiem**. Najbliższym wzorcem w repo jest **harness
`openrouter`**: serwerowa pętla LLM + lokalne narzędzia workspace
(`lib/agent-harness/openrouter-agent-loop.js` + `tool-executor.js`).

Rekomendacja:

1. Dodać transport `mistral` jako **wbudowany harness** sterowany oficjalnym
   `@mistralai/mistralai` (v2.7.0, ESM) — jako `optionalDependency`, zgodnie z
   wzorcem `@qwen-code/sdk` / `@openai/codex-sdk`.
2. **Reużyć** istniejącą pętlę agenta z `openrouter-agent-loop.js`. Pętla już
   przyjmuje wstrzykiwany `options.streamChatCompletion` (linia 98), więc nowy
   harness dostarcza tylko funkcję streamującą i przekazuje `transport`.
3. W Fazie 1 sklonować pętlę i klienta OpenRoutera
   (`mistral-agent-loop.js`, `mistral-client.js`) — zero ryzyka regresji
   OpenRoutera; scalenie do `lib/agent-harness/llm-tool-loop.js` osobnym
   commitem po zielonych testach (usuwa ~240 linii duplikacji).
4. Trzymać `AgentTransport` jako jedno źródło prawdy i przejść checklistę
   wszystkich miejsc, które wyliczają transporty (sekcja 5).
5. Mistral traktować w Plan/Ask/Review jak OpenRouter: **filtrowanie mutujących
   narzędzi z listy tools** (`preExecDeny: true`, `abortOnMutation: false`,
   `promptHint: false`).
6. Domyślny model: **`mistral-medium-latest`** (agentowe kodowanie); NIE używać
   wycofywanych `devstral-*` / `magistral-*`.

Szacunek: ~45 plików backendu/frontendu + testy/docs; 5–7 dni dla jednej osoby
znającej repo, przy czym większość to przejście wzorca OpenRouter i checklisty
transportów.

---

## 1. Risercz: Mistral AI

### 1.1 Oficjalne SDK dla Node/TypeScript

| Cecha | Wartość |
|-------|---------|
| Pakiet | `@mistralai/mistralai` |
| Wersja (npm, sprawdzona) | **2.7.0** (publikacja 2026-09-09) |
| Typ | **ESM-only w v2** — `"type": "module"`, `main: ./esm/index.js`, brak `require`/CJS; `import` z ESM działa bez build-stepu |
| Runtime | `engines` brak; `RUNTIMES.md` wymaga ES2020+, Fetch, Web Streams, async iterables; wspiera Node 20/22 LTS, Bun, Deno |
| Licencja | Apache-2.0 (Speakeasy-generated) |
| Repo | `github.com/mistralai/client-ts` |
| Zależności | `ws ^8.18`, `zod ^3.25 || ^4.0` (SDK importuje `zod/v4`), `zod-to-json-schema`, `@opentelemetry/semantic-conventions` |
| Inne pakiety | `@mistralai/mistralai-gcp@2.0.0`, `@mistralai/mistralai-azure@2.0.0`; **nie istnieje** unscoped npm `mistralai` |
| v1 | `@mistralai/mistralai@1.15.1` (CJS-era); eksport `MistralClient` rzuca „deprecated” — nie używać |

Klient (zweryfikowane z `esm/sdk/sdk.d.ts` + `esm/lib/config.d.ts`):

```js
import { Mistral } from '@mistralai/mistralai';

const client = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY, // string albo async () => Promise<string>
  serverURL: 'https://api.mistral.ai', // lub server: 'global' | 'eu' | 'us'
  // timeoutMs, retryConfig, debugLogger, httpClient
});
```

`zod` wchodzi jako zależność SDK (subpath `zod/v4`). Projekt nie używa `zod`
bezpośrednio, więc nie ma konfliktu, ale jako `optionalDependency` SDK nie może
wywrócić `npm install` w środowiskach bez Mistrala. Sprawdzić `npm ls zod`.

### 1.2 Auth i endpointy

- Klucz: `MISTRAL_API_KEY` (Bearer). Cretli dodatkowo `mistralApiKey` w
  `data/config.json` (wzorzec `openrouterApiKey`).
- Regiony / base URL: global `https://api.mistral.ai` (domyślny), EU
  `https://api.eu.mistral.ai` (`server: 'eu'`), US `https://api.us.mistral.ai`
  (`server: 'us'`). SDK dokłada `/v1`.
- Możliwy override `serverURL` / `server` (self-hosted/sovereign). Warto
  wystawić opcjonalne `mistralBaseUrl` w Settings.
- Hosted **MCP endpoint**: `https://api.mistral.ai/mcp` (Streamable HTTP, ten
  sam Bearer) — nieużywany w MVP, bo MCP wchodzi hostowo.
- Header: `Authorization: Bearer <key>`. `apiKey` może być stringiem albo
  `() => Promise<string>` (rotacja).

### 1.3 Chat Completions, streaming i tool calling

Mistral używa **OpenAI-kompatybilnego schematu** narzędzi:

```jsonc
{
  "model": "mistral-large-latest",
  "messages": [{ "role": "user", "content": "..." }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "...",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
    }
  }],
  "tool_choice": "auto",
  "stream": true
}
```

Streaming (SDK, zweryfikowane z opublikowanych typów 2.7.0):

```js
const events = await client.chat.stream({
  model,
  messages,
  tools,
  toolChoice: 'auto',        // 'auto' | 'none' | 'any' | 'required' | {type:'function',function:{name}}
  parallelToolCalls: true,   // domyślnie true
});
for await (const event of events) {         // EventStream<CompletionEvent>
  const chunk = event.data;                 // CompletionChunk
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;              // DeltaMessage
  // delta.content    -> string LUB Array<ContentChunk> (thinking/image/reference)
  // delta.toolCalls  -> ToolCall[] { id?, type?, function:{name,arguments}, index? }
  // choice.finishReason -> 'stop' | 'length' | 'error' | 'tool_calls'
  // chunk.usage      -> { promptTokens, completionTokens, totalTokens }
}
```

Typy (z `esm/models/components/*.d.ts`):

```ts
CompletionEvent = { data: CompletionChunk }
CompletionChunk = { id, object?, created?, model, usage?: UsageInfo, choices: Choice[] }
Choice = { index, delta: DeltaMessage, finishReason: 'stop'|'length'|'error'|'tool_calls'|null }
DeltaMessage = { role?, content?: string | ContentChunk[], toolCalls?: ToolCall[], toolCallId?, index?, metadata? }
ToolCall = { id?, type?, function: { name, arguments: object | string }, index? }
UsageInfo = { promptTokens?, completionTokens?, totalTokens?, ... }
```

To pasuje do kontraktu `toolCallBuilders[index]`, który już konsumuje
`lib/agent-harness/openrouter-agent-loop.js` (linie 90–133). Nowy klient musi
znormalizować chunk SDK do `{ deltaText, toolCallDeltas, finishReason, usage,
error }`.

Ważne niuanse (potwierdzone):

- **`delta.toolCalls` jest camelCase** (nie `tool_calls`) — obecny wrapper
  OpenRouter czyta `delta.tool_calls`; normalizacja w `mistral-client.js` jest
  obowiązkowa (ryzyko R1 zmaterializowane).
- **`function.arguments` to `string | object`** — jeśli string, akumuluj i
  `JSON.parse`; jeśli obiekt (np. non-stream), serializuj. Obecna pętla
  zakłada string (`entry.arguments = ${entry.arguments || ''}${...}`).
- **`ToolCall.id` to krótki, nieprzejrzysty string** (np. `D681PevKs`) — trzeba
  go echo-ować dosłownie w `assistant.tool_calls` i w wiadomości `tool`
  (`toolCallId` / `tool_call_id`).
- **`content` może być tablicą** (`thinking` przy `reasoning_effort`, obraz,
  referencje) — guard `typeof content === 'string'`, inaczej `[object Object]`.
- **`finishReason: 'tool_calls'`** — decyzja pętli i tak pada na
  `pendingToolCalls`, ale `getOpenRouterFinishReasonError` przepuszcza tylko
  `network_error`; dodać mapowanie `'error'` → błąd.
- **`tool_choice: 'required'` zamiast `'any'`** dla wymuszenia narzędzia
  (Mistral akceptuje oba, ale OpenAI-owy klient rozumie `required`).
- **`usage` tylko w ostatnim chunku** — przepuścić do `usage` eventu, żeby
  usage-ledger (`recordHarnessUsageDelta`) działał.
- SDK ma też `client.chat.parse` / `chat.parseStream` (Zod) — nie używamy.

Kolejny request musi zawrzeć wiadomość `assistant` z `tool_calls` oraz
wiadomości `tool` z `tool_call_id` — to samo, co robi pętla (linie 172–222).
Równoległe wywołania narzędzi: Mistral wspiera, domyślnie włączone; pętla
obsługuje wiele `pendingToolCalls` w jednej turze.

### 1.4 Agents API i Conversations API (beta)

Mistral oferuje też (namespace **`client.beta.*`**):

- **`client.beta.agents`** — utrwalone definicje agenta (model, instrukcje,
  narzędzia, wersje + aliasy). Stary `client.agents.complete`
  (`POST /v1/agents/completions`) jest **deprecated**.
- **`client.beta.conversations`** — stanowa historia po stronie Mistrala
  (`conversation_id`), start z `agentId` **lub** gołym `model`, `store:false`
  opt-out.
- **Wbudowane narzędzia agenta**: `function`, `web_search`,
  `web_search_premium`, `code_interpreter`, `image_generation`,
  `document_library` (RAG).
- **MCP connectors** — `client.beta.connectors.create/list/listTools/callTool/
  getAuthUrl`; zdalny `https://api.mistral.ai/mcp`. Handoffy między agentami
  (`handoff_execution: 'server' | 'client'`).
- Agents wspierają na dziś `mistral-medium-latest` / `mistral-large-latest`.

**Decyzja: NIE używamy Agents/Conversations w v1.** Powody:

- Cretli ma własny kontrakt historii (`chat-history-persist.js`), replay do
  klienta (`/ws-agent-sdk`) i własny `tool-executor` (sandbox workspace,
  Plan/Review guard, MCP). Stan po stronie Mistrala dublowałby źródło prawdy i
  łamał `room-kernel`.
- Wbudowane narzędzia Mistrala (code interpreter, web search) omijają hostowe
  bariery bezpieczeństwa Cretli (Plan/Ask/Review read-only, scout read-only).
- OpenRouter już ustalił sprawdzony wzorzec „LLM + host tools”, którego
  delegacje, usage i recovery oczekują.

Agents API warto rozważyć w przyszłej fazie jako osobny, opt-in tryb (np.
`mistralMode: 'agents'`), ale nie w MVP.

### 1.5 Modele

Stan na 2026-10 (katalog dynamiczny; **nie hardkodować na sztywno**):

| API id | Alias | Kontekst | FC | Vision | Status |
|--------|-------|----------|----|--------|--------|
| `mistral-large-4` | `mistral-large-4-0` / `mistral-large-latest` | **1M** | tak | tak | najnowszy flagowy (2026-10-06), `reasoning_effort` `none`/`high` |
| `mistral-large-3` | `mistral-large-latest` | 256k | tak | tak | poprzedni flagowy |
| `mistral-medium-3-5` | `mistral-medium-latest` | 256k | tak | tak | **najlepszy do agentowego kodowania** |
| `mistral-small-4` | `mistral-small-latest` | 256k | tak | tak | tani, hybrydowy |
| `codestral-2508` | `codestral-latest` | 128k | tak | — | kod/FIM |
| `ministral-{14b,8b,3b}-2512` | `ministral-*-latest` | 256k | tak | tak | małe/edge, Apache-2.0 |
| `devstral-2512` | `devstral-latest` | 256k | tak | — | **DEPRECATED** 2026-05-22 → Medium 3.5 |
| `magistral-{medium,small}-2509` | `magistral-*-latest` | 128k | tak | — | **DEPRECATED** → Medium 3.5 / Small 4 |

Wniosek: **domyślny model to `mistral-medium-latest`** (agentowe kodowanie, bez
deprecacji), a `mistral-large-latest` dla trudnych zadań / 1M kontekstu. NIE
budować na `devstral-*` ani `magistral-*` (moja wcześniejsza lista była błędna —
oba są na ścieżce deprecacji).

Listę live pobieramy z `GET /v1/models` (SDK: `client.models.list()`), z TTL i
cache — analogicznie do `lib/deepseek/deepseek-models.js` i
`lib/routes/openrouter-routes.js`. `ModelList.data[]` (`BaseModelCard`) niesie:
`id`, `name`, `description`, `aliases`, `maxContextLength`,
`capabilities{ functionCalling, vision, reasoning, completionChat,
completionFim, ... }`, `deprecation`, `deprecationReplacementModel`. Endpoint
wymaga klucza (401 bez).

Fallback (gdy brak klucza/sieci) powinien mapować na: `mistral-medium-latest`,
`mistral-large-latest`, `mistral-small-latest`, `codestral-latest`,
`ministral-8b-latest`, `ministral-3b-latest`. Aliasy `-latest` rozwiązywać w
runtime przez `models.list()` (polityka „latest across generations”).

### 1.6 Multimodalność

Mistral przyjmuje obrazy jako części treści (SDK camelCase `imageUrl`, wire
`image_url`):

```js
content: [
  { type: 'text', text: 'Co jest na obrazie?' },
  { type: 'image_url', imageUrl: 'https://…/x.jpg' },
  // albo { type: 'image_url', imageUrl: 'data:image/png;base64,…' }
]
```

Limity: max 8 obrazów/request, 10 MB każdy, PNG/JPEG/WEBP/GIF (jedna klatka);
max rozdzielczość 1540×1540 (Large 3 / Medium 3 / Small 3.2 / Ministral 3),
twardy błąd >10000×10000; obrazy liczone jako tokeny wejściowe
(≈ `(w*h)/784`, do ~3025). Vision mają: Large 4, Large 3, Medium 3.x, Small
4/3.2, Ministral 3.

Cretli ma już `lib/sdk/sdk-prompt-images.js`, a front wysyła obrazy promptem.
Dla `mistral`:

- model z `capabilities.vision === true` → dołączyć obraz jako `image_url`;
- model bez vision → pominąć obraz z ostrzeżeniem (wzorzec
  `isDeepSeekVisionModel`); wykrywanie z `models.list()`.

To może być faza 2 (najpierw tekst + narzędzia), ale kontrakt wiadomości trzeba
zaprojektować od razu, żeby nie zmieniać historii. Uwaga: w odczycie strumienia
`delta.content` może być tablicą (`thinking`, obraz) — guard `typeof === 'string'`.

### 1.7 Błędy i limity

- `401` — zły/brak/unieważniony klucz albo klucz z innego workspace; czytelny
  komunikat jak w `lib/openrouter/openrouter-client.js` (mapowanie na
  `sdkError.code = mistral_auth_error`).
- `402` — billing; `403` — plan/uprawnienia workspace; `404` — zły **lub
  wycofany** model; `422` — walidacja (np. narzędzia nieobsługiwane przez
  model).
- `429` — rate limit; Mistral zwraca **`Retry-After`**; zmapować na
  `harness-usage-limits.js` (`noteHarnessUsageLimit`) i `sdkError.code =
  mistral_rate_limit`.
- `500/502/503/504` — przejściowe; SDK ma wbudowany `retryConfig`
  (`strategy: 'backoff'`, `retryConnectionErrors`) + per-call
  `retries`/`retryCodes`/`timeoutMs`.
- Body błędu: `{ object: 'error', message, type, param, code }`. SDK
  `MistralError` eksponuje `message`, `statusCode`, `headers` (odczyt
  `Retry-After`), `body`.
- Limity są **workspace-scoped i wspólne dla kluczy**, per model (tokens/min,
  req/s) w konsoli Admin; brak sztywnych liczb w dokumentacji.
- `422` (tools odrzucone): obecna pętla OpenRouter robi cichy fallback „retry
  bez tools” — dla Mistrala lepiej zwrócić jawny błąd, bo degradacja bez
  narzędzi myli użytkownika.
- Timeouty: SDK ma własny; pętla ma `AbortSignal` (`room.abortController`).

### 1.8 Źródła

- npm: [`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai)
  (wersja 2.7.0, ESM, zależności; `npm view` + rozpakowany tarball).
- Repo SDK: [github.com/mistralai/client-ts](https://github.com/mistralai/client-ts)
  (+ `RUNTIMES.md`, `MIGRATION.md`).
- Dokumentacja: [docs.mistral.ai](https://docs.mistral.ai/)
  - [Chat completions](https://docs.mistral.ai/studio/conversations/chat-completion),
    [Function calling](https://docs.mistral.ai/studio/conversations/function-calling),
    [Vision](https://docs.mistral.ai/studio/conversations/vision);
  - [Agents intro](https://docs.mistral.ai/studio/agents/introduction),
    [Agents & Conversations](https://docs.mistral.ai/studio/agents/agents-api),
    [deprecated agents](https://docs.mistral.ai/api/endpoint/deprecated/agents),
    [Connectors](https://docs.mistral.ai/studio/connectors/tool_calling),
    [MCP](https://docs.mistral.ai/resources/mcp);
  - [Models](https://docs.mistral.ai/models),
    [Model lifecycle](https://docs.mistral.ai/inference/model-lifecycle),
    [List models](https://docs.mistral.ai/api/endpoint/models),
    [Mistral Large 4](https://docs.mistral.ai/models/mistral-large-4-0),
    [Mistral Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04),
    [Devstral (deprecated)](https://docs.mistral.ai/models/devstral-2-25-12),
    [Codestral](https://docs.mistral.ai/models/codestral-25-08);
  - [Error glossary](https://docs.mistral.ai/resources/error-glossary),
    [Migration guides](https://docs.mistral.ai/resources/migration-guides),
    [Usage & limits](https://docs.mistral.ai/admin/billing-usage/usage-limits).

> Kształt chunku i typy SDK są **zweryfikowane** z opublikowanego tarballa
> `@mistralai/mistralai@2.7.0` (`esm/models/components/*.d.ts`). Spike w Fazie 0
> ogranicza się do realnego wywołania z kluczem (tools + mapa modeli).

---

## 2. Decyzja architektoniczna

### 2.1 Wzorzec: OpenRouter, nie Claude/Codex

| Wzorzec | Harnessy | Charakterystyka | Czy Mistral? |
|---------|----------|-----------------|--------------|
| Vendor CLI / agent SDK | `claude`, `codex`, `deepseek`, `qwen`, `codebuddy`, `opencode` | SDK prowadzi własną pętlę narzędzi, własne sesje, własne permissione | **Nie** — Mistral to surowy LLM |
| Host LLM + host tools | `openrouter` | `streamChatCompletion` + `runOpenRouterAgentLoop` + `tool-executor` | **Tak** |

Mistral wpisuje się w drugi wzorzec. Dzięki temu reużywamy:

- `lib/agent-harness/room-kernel.js` — broadcast, event log, persist buffer,
  replay, heartbeat, usage, agent-finished push, presence.
- `lib/agent-harness/tool-executor.js` + `tool-definitions.js` — narzędzia
  workspace (read/write/grep/shell/git) z guardami Plan/Review.
- `lib/agent-harness/event-normalizer.js` — zdarzenia `assistant`/`tool_call`/
  `user` w kształcie SDK.
- `lib/agent-harness/openrouter-agent-loop.js` — pętla tool-call.
- `lib/mcp/mcp-openrouter-tools.js` — narzędzia MCP jako function tools.
- `lib/sdk/harness-plan-prompt.js`, `harness-plan-sync.js`,
  `lib/delegation-run-bridge.js`, `lib/prompt-ui-text.js`.

### 2.2 SDK vs `fetch`

Dwa warianty, oba sprowadzają się do tego samego kontraktu
`streamMistralChatCompletion(options)`:

**Wariant A — oficjalny `@mistralai/mistralai` (rekomendowany, bo o to prosi
zadanie).** Uzasadnienie:

- Użytkownik wprost prosi o „sdk mistral ai”.
- SDK daje typy, retry/backoff, obsługę `zod` structured outputs i gotowy
  async-iterator streamu.
- `optionalDependency` + probe `isMistralSdkAvailable()` utrzymuje spójność z
  `qwen-sdk.js` / `codex-sdk.js` / `claude-sdk.js`.
- Koszt: kilka MB w `node_modules` (serwer, nie front). Ryzyko: nowe
  `zod`/`zod-to-json-schema` w drzewie; `harness-status.available` zależy od
  instalacji.

**Wariant B — własny `fetch` + SSE (jak OpenRouter).** API Mistrala jest
OpenAI-kompatybilne, a `openrouter-client.js` to gotowy parser
`choices[].delta.content` / `delta.tool_calls`. Zalety: zero nowych zależności,
`available: true` na sztywno (brak bramki instalacyjnej), spójność z
OpenRouterem, mniejsza powierzchnia ryzyka w Termux. Wady: własna obsługa
błędów/retry i brak typów; nie „oficjalny SDK”.

Decyzja: **A jako cel, B jako natychmiastowy fallback**. Interfejs klienta jest
identyczny, więc przełączenie to podmiana jednego pliku
(`lib/mistral/mistral-client.js`) i ewentualnie `lib/harness-status.js`
(`available: true`). Spike w Fazie 0 rozstrzyga ostatecznie (np. jeśli
`zod`/`@opentelemetry` sprawią problem w drzewie zależności).

### 2.3 Refaktor pętli (jedyne ryzykowne miejsce)

`runOpenRouterAgentLoop` ma dwa sprzężenia z OpenRouterem:

1. `getToolsForMode(mode, options.assignment)` — wewnątrz wywołuje
   `resolveHarnessReadOnlyPolicy('openrouter', ...)` (twarde `'openrouter'`).
2. `getOpenRouterFinishReasonError(finishReason)` — nazwa, ale logika jest
   generyczna (`network_error`).
3. Domyślny `SYSTEM_PROMPT` — tekst neutralny („coding agent inside Cretli”).

Plan minimalny (mały diff): dodać `options.transport` i `options.systemPrompt`,
przekazać transport do `getToolsForMode`. Plan docelowy (rekomendowany):
przenieść pętlę do `lib/agent-harness/llm-tool-loop.js` jako
`runLlmToolLoop(options)`, a `runOpenRouterAgentLoop` zostawić jako cienki
wrapper (`return runLlmToolLoop({ ...options, transport: 'openrouter' })`).
Testy istniejące (`tests/` pętli) przechodzą bez zmian.

Alternatywa „clone first” (bez refaktoru OpenRoutera): skopiować
`openrouter-agent-loop.js` → `lib/agent-harness/mistral-agent-loop.js` i
`openrouter-client.js` → `lib/agent-harness/mistral-client.js`. Jest to
**najbezpieczniejsze dla pierwszego commita** (zero ryzyka regresji OpenRoutera),
kosztem ~430 linii duplikacji do późniejszego scalenia. Rekomendacja: zacząć od
klonu w Fazie 1, a refaktor do `llm-tool-loop.js` zrobić osobnym commitem po
zielonych testach Mistrala (ryzyko R7 niżej).

---

## 3. Kontrakty

### 3.1 Klient strumienia

```js
/**
 * @param {{
 *   model: string,
 *   messages: Array<Record<string, unknown>>,
 *   tools?: Array<Record<string, unknown>>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 * @returns {AsyncGenerator<{
 *   deltaText?: string,
 *   toolCallDeltas?: Array<{ index?: number, id?: string, function?: { name?: string, arguments?: string } }>,
 *   finishReason?: string,
 *   usage?: Record<string, unknown>,
 *   error?: { message?: string, code?: string },
 * }>}
 */
export async function* streamMistralChatCompletion(options) {}
```

Musi zwracać **ten sam kształt** co `streamOpenRouterChatCompletion`, żeby pętla
działała bez zmian.

### 3.2 Handler WS (wzorzec 1:1 z `openrouter-agent-ws.js`)

Eksporty `lib/mistral/mistral-agent-ws.js`:

- `handleMistralAgentWebSocket(ws, sessionKey, deps)`
- `ensureMistralRoom(sessionKey, deps)`
- `disposeMistralRoom(sessionKey)`
- `startMistralChatRun(input)`
- `cancelMistralChatRun(input)`
- `getMistralRoomDiag(sessionKey)`
- `syncMistralRoomModelFromChat(sessionKey, model)`
- `registerChatRunAdapter({ transport: 'mistral', ... })` (side effect)

Eventy WS (te same co OpenRouter): `sdkPromptStarted`, `sdkBusy`, `sdkEvent`,
`sdkRunFinished`, `sdkError`, `sdkQueued`, `hello`, `sdkRoomState`.

### 3.3 Hello

`lib/sdk/sdk-ws-handshake.js:23` — dodać `'mistral'` do `helloTransports`,
inaczej klient dostanie `transport: 'cursor-sdk'` i złe etykiety.

---

## 4. Fazy implementacji

### Faza 0 — spike techniczny (0.5 dnia)

Cel: potwierdzić kontrakt SDK zanim powstanie kod produkcyjny.

1. `npm i --no-save @mistralai/mistralai@2.7.0`.
2. Skrypt `scripts/spike-mistral.mjs` (nietrwały, poza commitem):
   - `client.models.list()` → lista ID;
   - `client.chat.stream({ model: 'mistral-small-latest', messages, tools })` →
     wypisz surowe eventy (`JSON.stringify`), potwierdź `delta.toolCalls`,
     `finishReason`, `usage`;
   - wymuś wywołanie narzędzia i domknij pętlę (assistant.tool_calls → tool
     result) drugim requestem.
3. Ustalić, które modele wspierają tools/vision.

Wyjście: notatka z kształtem chunku + decyzja SDK-vs-fetch. **Bez tego nie
zaczynamy Fazy 1.**

### Faza 1 — transport i pętla (1–1.5 dnia)

1. `lib/agent-transport.js` — `'mistral'` w typedef, `VALID_TRANSPORTS`,
   `isMistralChat`, `usesHarnessWebSocket`.
2. `lib/agent-harness/types.js` — typedef.
3. `lib/agent-harness/registry.js` — wpis `mistral` (label „Mistral AI”,
   opis z SDK).
4. Refaktor pętli:
   - `lib/agent-harness/llm-tool-loop.js` (`runLlmToolLoop`), transport w
     opcjach;
   - `lib/agent-harness/openrouter-agent-loop.js` → wrapper.
5. `lib/agent-harness/tool-definitions.js` — `getToolsForMode(mode, assignment,
   transport = 'openrouter')`.
6. `lib/agent-harness/harness-plan-policy.js` — `mistral` (kopia `openrouter`:
   `nativeMode:false, denyMutatingTools:true, abortOnMutation:false,
   promptHint:false`).
7. `lib/mistral/mistral-client.js` — `streamMistralChatCompletion`.
8. `lib/mistral/mistral-conversation-hydrate.js` — historia → messages (wzorzec
   `openrouter-conversation-hydrate.js`).
9. `lib/mistral/mistral-agent-ws.js` — room kernel + adapter (wzorzec
   `openrouter-agent-ws.js`, z `decorateHarnessPrompt(room, text, 'mistral')`).
10. `lib/mistral/mistral-sdk.js` — `loadMistralSdk`, `isMistralSdkAvailable`,
    `createMistralSdkUnavailableError`.
11. `lib/mistral/mistral-api-key.js` — env → settings, `isValidMistralApiKeyFormat`
    (Mistral keys nie mają sztywnego prefiksu — walidacja miękka, np. długość),
    `getMistralApiKeyMetaForClient`.
12. `lib/ws/ws-router.js` — import + branch `isMistralChat` + `'mistral'` w
    warunku blokady PTY (`/ws-agent`).
13. `lib/agent-harness/builtin-harness-providers.js` — deskryptor
    `MISTRAL_HARNESS_PROVIDER` + lista.
14. `lib/sdk/sdk-ws-handshake.js` — `helloTransports`.
15. `package.json` — `optionalDependencies["@mistralai/mistralai"] = "^2.7.0"`.

### Faza 2 — katalog modeli, klucz, trasy (0.5–1 dnia)

1. `lib/mistral/mistral-models.js` — fallback lista, `listMistralModels`
   (`GET /v1/models` + cache TTL), `getMistralChatEnabledModels`,
   `resolveDefaultMistralModel`, `invalidateMistralModelsCache`,
   `catalogFromMistralModelsPayload`.
2. `lib/routes/mistral-routes.js` — `GET /api/mistral/status`,
   `GET /api/mistral/models` (wzorzec `deepseek-routes.js` /
   `openrouter-routes.js`).
3. `lib/register-app-routes.js` — `registerMistralRoutes(app)`.
4. `lib/persist/settings.js` — JSDoc (`mistralApiKey`, `mistralBaseUrl`,
   `mistralChatEnabledModels`, `defaultNewChatHarness` union).
5. `lib/routes/settings-routes.js`:
   - import key-meta + normalize;
   - `GET /api/settings` — dodać meta klucza i `mistralChatEnabledModels`;
   - zapis `mistralApiKey` / `mistralBaseUrl` / `clearMistralApiKey` /
     `mistralChatEnabledModels` / `defaultNewChatHarness === 'mistral'`.
6. `lib/harness-catalog.js` — `ENABLED_MODEL_KEYS.mistral`, import
   `listFallbackMistralModels`, branch `harness === 'mistral'`.
7. `lib/harness-status.js` — `mistral: { available: isMistralSdkAvailable(),
   configured: available && !!key }` + `anyConfigured`.
8. `lib/routes/chats-routes.js`:
   - guard new-chat (`else if (agentTransport === 'mistral')`) z komunikatem o
     kluczu i `npm install @mistralai/mistralai`;
   - default title `Mistral chat N`;
   - `disposeMistralRoom` / `getMistralRoomDiag` / `syncMistralRoomModelFromChat`
     w switchach (linie ~525, ~613, ~733, ~1153, ~1274).
9. `lib/notices.js` — `Mistral` w `HARNESS_TAG`.
10. `.env.example` — `MISTRAL_API_KEY=` (+ ewentualnie `MISTRAL_BASE_URL=`).

### Faza 3 — frontend (1.5–2 dnia)

Kolejność: najpierw enumy w `lib/` (Faza 1/2), potem transport/label, model
picker, Settings, first-run, na końcu ancillary lists.

1. **Transport + labels**
   - `app_front/features/chat/sdk-transport-labels.js` — `HELLO_TRANSPORTS`
     (4-13), `normalizeHarnessTransport` (19-23), typedef +
     `resolveHarnessDisplayLabel` (38-48: „Mistral”), `buildHarnessLaunchLabel`
     (70-97: `Mistral · …`).
   - `app_front/features/chat/sdkStateResolver.js` — `HELLO_TRANSPORTS` (6-15);
     bez tego `hello` z roomu mistral nie ustawi stanu agenta.
   - `app_front/features/chat/chatTransport.js` — bez enumu; dotknąć
     `resolveSdkRunFailureNotice` (121-131) tylko jeśli backend wyśle
     `mistral_auth_error` / `mistral_rate_limit`.
   - `app_front/features/chat/sdkRunOutcomeRecovery.js` — tylko jeśli backend
     wyśle dedykowany `lastErrorCode`; inaczej generyczny fallback wystarcza.
   - `app_front/lib/sdk-rich-view.js` — `appendSdkRunProgress` (5784-5790) zna
     tylko openrouter/opencode/sdk/claude → mistral renderuje się jako `[SDK]`;
     dodać branch (najlepiej zastąpić łańcuch `resolveHarnessDisplayLabel`).

2. **Model picker**
   - `app_front/features/chat/chatModelSelect.js` — `mistralModelCatalog` +
     `mistralEnabledModelKeys` (56-88), typedef (89/94),
     `normalizeModelPickerHarness` (96-106), `getCatalogStateForHarness`
     (112-136), `applyMistralEnabledModels` (191-234),
     `applyAvailableModelsFromMistral` (296-478 — kopiuj
     `applyAvailableModelsFromOpenRouter` 457-478), `getModelLabelByValue`
     (572-583), eksporty (882-910). Bez logiki wariantów/effort.
   - `app_front/features/chat/harnessModelUsage.js` — `Promise.allSettled`
     (44-53) + 9. `api.getMistralModels()`; odczyt (54-61); licznik (62-83:
     `mistral: countCatalogEnabledModels(catalogFromModelsPayload(mistral),
     settings?.mistralChatEnabledModels)`).
   - `app_front/chat.js` — `refreshPendingHarnessModelCatalog` (1670-1745),
     `applyMistralEnabledModels` (3424-3452), cache `cachedMistralReady`
     (6389-6396), readiness (6423-6455), error (6561-6571),
     `refreshNewChatMistralStatus` (6680-6929), status check (6963-7000),
     `NEW_CHAT_HARNESS_LABEL_KEYS` (7023-7032), voice (7928-7938),
     `createChatFromModal` disabled (8312-8338), context label (8866-8888),
     `getSettings()` block (9662-9681), window listenery (9682-9764:
     `cretli-mistral-models-changed`, `cretli-mistral-key-changed`).

3. **Settings UI**
   - `app_front/harnessSettings.js` — typedef (22), `normalizeDefaultHarness`
     (40-50), `harnessCatalog()` (111-122), `missingMistral` (206-227),
     event `cretli-mistral-models-changed` (392-407).
   - `app_front/lanSettings.js` (**pominięte w pierwszej wersji planu**) —
     `applyMistralApiKeyHint` (wzór `applyDeepSeekApiKeyHint` 202-222) z id
     `mistral-api-key-source-hint`, `mistral-api-key-input`,
     `mistral-api-key-save-status`; `applySettingsSnapshot` (465-520); blok
     save/clear (708-756) przez
     `patchSettings({ mistralApiKey })` / `patchSettings({ clearMistralApiKey: true })`
     + dispatch `cretli-mistral-key-changed`. **Bez** dedykowanych
     `saveMistralKey`/`clearMistralKey` w `api.js`.
   - `app_front/App.js` — import (60-66), `initMistralModelSettings()`
     (423-436), `refreshMistralModelSettingsPanel()` (1097-1110).
   - `public/index.html`:
     - tab bar (333-341): `data-settings-tab="harness-mistral"`;
     - subtab bar po 378: `harness-mistral-keys|models|stats`;
     - Keys section (wzór DeepSeek 660-684) z `id="mistral-api-settings"`;
     - Models section (wzór DeepSeek 1339-1366) z `mistral-model-settings-*`;
     - Stats section `data-harness-id="mistral"`;
     - statyczny `#chat-new-harness-select` (2477-2485): `<option
       value="mistral">Mistral</option>` (fallback przed loadem Settings).
   - `app_front/mistralModelSettings.js` — nowy moduł; **bazą jest
     `openrouterModelSettings.js`** (raw-LLM, generyczny katalog `{id,name}`,
     bez CLI/effort/billing), plus panel statusu z
     `deepseekModelSettings.js` (`refreshDeepSeekStatusPanel` → 
     `refreshMistralStatusPanel` z `api.getMistralStatus()`). Klucze LS:
     `cretli-mistral-models-sort`; save przez
     `patchSettings({ mistralChatEnabledModels })`.

4. **First-run / new-chat**
   - `app_front/features/setup/firstRunSetup.js` — typedef (13),
     `HARNESS_KEY_FIELD` (15-24: `mistral: 'mistralApiKey'`),
     `HARNESS_HINT_KEY` (26-35: `mistral: 'firstRun.hintMistral'`),
     `normalizeHarness` (41-45), `listAvailableHarnesses` (51-63). Bez
     specjalnego auth-mode.
   - `app_front/features/chat/newChatHarnessStatus.js` —
     `normalizeNewChatHarnessId` (21-33).

5. **Mode bar, sidebar, ancillary**
   - `app_front/components/chat/cr-sdk-mode-bar.js` — `normalizeBarHarness`
     (400-405), `allHarnessOptions` (788-797).
   - `public/harness-icons/mistral.svg` (nowy) +
     `app_front/features/sidebar/sidebarView.js` icon map (363-373).
   - `app_front/features/sidebar/sidebarChatRowModel.js` — label (41-51) +
     valid ids (54).
   - `app_front/features/settings/mcpSettings.js` — `HARNESSES` (9-18).
   - `app_front/features/watcher/scoutProfileEditorView.js` —
     `SCOUT_EDITOR_HARNESSES` (73-82).
   - `app_front/features/usage/usageSettings.js` — `HARNESS_LABEL_KEYS`
     (62-73).
   - `app_front/features/usage/usageCharts.js` — **NIE dodawać** do
     `SUBSCRIPTION_HARNESSES` (27): Mistral to pay-per-use, nie prepaid.
   - `app_front/features/voice/voiceHarnessMatch.js` — typedef (6) + regex
     (8-25: `/\bmistral\b/`).
   - `app_front/features/voice/realtimeTools.js` (437/460) — kosmetyczne
     komunikaty.
   - `app_front/features/chat/harnessSettingsLoad.js` — tylko komentarz
     („seven harness catalogs”).

#### 4.1 Klucze i18n

Konwencja: `<section>.<camelCase>`; blok harnessu w `settings` obok
`harnessCodeBuddy…`; błędy runtime w `chat`; first-run w `firstRun`; hinty
klucza w `lanSettings`; labelki usage w `usage`.

Dodać (wzór DeepSeek): `settings.harnessMistral`,
`settings.harnessStatusMistralMissing`, `settings.harnessMistralApiTitle`,
`settings.harnessMistralHintPrefix`, `settings.harnessMistralHintSuffix`,
`settings.harnessMistralApiKeyLabel`, `settings.harnessMistralApiKeyPlaceholder`,
`settings.harnessMistralApiKeySave`, `settings.harnessMistralApiKeyClear`,
`settings.harnessMistralNotReadyNoKey`, `settings.harnessMistralNotReady`,
`settings.harnessMistralReady`, `settings.harnessMistralModelsTitle`,
`settings.harnessMistralModelsHint`, `settings.harnessMistralModelsEmpty`,
`firstRun.hintMistral`, `chat.harnessErrorMistral`, `chat.mistralDisabled`,
`chat.mistralSdkMissing` (jeśli SDK jest probowane), `chat.mistralStatusFailed`,
`chat.contextDetailsTransportMistral`, `chat.mistralAuthError`,
`chat.mistralRateLimitError`, `lanSettings.mistralKeyFromEnv`,
`lanSettings.mistralKeyStored`, `lanSettings.mistralKeyMissing`,
`usage.harnessMistral`. Opcjonalnie `settings.harnessMistralBaseUrlLabel` /
`Placeholder`, jeśli wystawiamy `mistralBaseUrl`.

Reużywane bez zmian: `settings.harnessSubtabKeys|Models|Stats`,
`settings.chatModels*`, `harnessHealth.statsRange`.

### Faza 4 — delegacje, MCP, usage, scout, recovery (1 dnia)

1. `lib/delegation-executor.js` — normalizacja enabled models dla `mistral`.
2. `lib/delegation-adapter-capabilities.js` —
   `DEFAULTS.mistral` (kopia `openrouter`: `canReconstructSession:false`,
   `preExecDeny:true`, `abortOnMutation:false`, `sandboxReadOnly:false`) +
   `review_can_run_tests: true` w traits (host `run_terminal_command` pozwala na
   `review-verify`).
3. `lib/mcp/adapters/mistral-adapter.js` + `lib/mcp/adapters/index.js` —
   `{ harness: 'mistral', transports: ['stdio','http'], liveUpdate: true,
   callControl: 'managed' }`.
4. `lib/mcp/mcp-openrouter-tools.js` — uogólnić do
   `loadHarnessMcpTools(context, harness)` (lub dodać cienki
   `loadMistralMcpTools`). Mistral nie potrzebuje własnej konfiguracji MCP —
   narzędzia wchodzą jako function tools.
5. Usage/telematria — cztery pliki (bez tego `createUsageEvent` po cichu
   odrzuca harness):
   - `lib/usage/usage-event.js` — `'mistral'` w `USAGE_HARNESSES`;
   - `lib/usage/usage-contract.js` — `'mistral'` w `USAGE_MATRIX_HARNESSES` +
     wiersz `mistral: defineContract({...})` w `USAGE_HARNESS_MATRIX` (wzorzec
     wiersza OpenRouter: `usageShape:'resolved'`, `measurementKind:'delta'`,
     `granularity:'run'`, `source:'lib/agent-harness/mistral-agent-loop.js'`);
     opcjonalnie `mistral:'mistral'` w `PROVIDER_HARNESS_FALLBACK`;
   - `lib/usage/usage-normalize.js` — `fromMistralUsage(usage)` (klon
     `fromOpenRouterUsage`: OpenAI `prompt_tokens` / `completion_tokens` /
     `prompt_tokens_details.cached_tokens`);
   - `lib/usage/harness-usage.js` — `mistral:'mistral'` w `HARNESS_PROVIDERS`
     + branch `if (harness === 'mistral') return fromMistralUsage(usage)` w
     `resolveHarnessUsageTokens`.
   `lib/harness-usage-limits.js` **nie wymaga zmian** — jest kluczowany
   dynamicznie po `(harness, model)`.
6. `lib/spa-routes.js` — `'mistral'` w `SPA_HARNESS_IDS` **oraz**
   `'harness-mistral'` w `SPA_SETTINGS_TABS` (sub-taby
   `harness-mistral-{keys,models,stats}` generują się z listy).
7. `lib/workspace-scout-read-only.js` — `SCOUT_READ_ONLY_ENFORCING_HARNESSES`
   (host filtruje mutujące tools, więc można dołączyć).
8. `lib/recovery/recovery-contract.js` — `mistral` do
   `RECOVERY_DEFERRED_ADAPTERS` + powód (jak `openrouter`: odtwarza tylko tekst
   user/assistant, bez pełnej pętli tool-call/tool-result).
9. `lib/delegation-run-bridge.js:264` — jeśli liczymy tokeny per transport,
   dołączyć `'mistral'`.
10. `lib/model-catalog-meta.js` — dodanie `mistral` do `MODEL_PROVIDER_ORDER` /
    `MODEL_PROVIDER_LABELS` (`mistral: 'Mistral'`) i detekcji id
    (`if (id.startsWith('mistral') || id.startsWith('codestral') ||
    id.startsWith('devstral') || id.startsWith('magistral') ||
    id.startsWith('ministral')) return 'mistral'`).
11. `lib/model-score-heuristics.js` + `lib/model-role-profiles.js` — pattern
    `mistral` (tierowanie koszt/jakość i role), opcjonalne.
12. `lib/chat-title-providers.js` — opcjonalny provider auto-title `mistral`.
13. `lib/mcp/builtin/delegation-tools.js` — opis listy harnessów + „Mistral”.
14. `.agents/skills/cretli-multi-harness/SKILL.md` i
    `.cursor/agents/cretli-multi-harness.md` — lista harnessów.

### Faza 5 — testy (0.5–1 dnia)

Zobacz sekcję 6.

### Faza 6 — dokumentacja i changelog (0.25 dnia)

1. `docs/mistral/SETUP.md` (nowy) — klucz, `npm install`, modele, tryb Plan.
2. `docs/ARCHITECTURE.md`:
   - lista transportów w „Agent harnesses” (linia 75),
   - wiersz tabeli (linia 77–86),
   - „All eight harnesses…” → „All nine harnesses…”,
   - `lib/mistral/` w drzewie modułów (linia 13),
   - endpointy `GET /api/mistral/status|models` (tabela HTTP),
   - mapa przepływu `Chat (Mistral) → /ws-agent-sdk → Mistral API + tool loop`.
3. `README.md` — backends, „Bring your own API keys”, sekcja setup H, tabela env.
4. `CHANGELOG.md` — wpis w Unreleased.
5. `docs/mistral-sdk-plan.md` (ten plik) — oznaczyć jako zrealizowany / usunąć.

---

## 5. Pełna checklista plików

### Backend — nowe

| Plik | Rola |
|------|------|
| `lib/mistral/mistral-sdk.js` | opcjonalny import + `isMistralSdkAvailable` |
| `lib/mistral/mistral-api-key.js` | env/settings, meta dla klienta |
| `lib/mistral/mistral-client.js` | `streamMistralChatCompletion` → znormalizowane chunki |
| `lib/mistral/mistral-models.js` | fallback + live katalog + enabled ids |
| `lib/mistral/mistral-conversation-hydrate.js` | historia → messages |
| `lib/mistral/mistral-agent-ws.js` | room kernel + adapter czatu |
| `lib/routes/mistral-routes.js` | `/api/mistral/status`, `/api/mistral/models` |
| `lib/mcp/adapters/mistral-adapter.js` | adapter MCP |
| `lib/agent-harness/mistral-agent-loop.js` | (wariant „clone first”) pętla Mistrala |
| `lib/agent-harness/mistral-client.js` | (wariant „clone first”) klient SSE |
| `lib/agent-harness/llm-tool-loop.js` | (późniejszy refaktor) generyczna pętla |

> Wariant „clone first”: `mistral-agent-loop.js` + `mistral-client.js` to kopie
> plików OpenRoutera. Wariant docelowy scala je do `llm-tool-loop.js` i jednego
> `mistral-client.js`, zostawiając `runOpenRouterAgentLoop` jako wrapper.
> `lib/mistral/mistral-client.js` (SDK) i `lib/agent-harness/mistral-client.js`
> (fetch/SSE) to **alternatywy** — wybieramy jedną w Fazie 0.

### Backend — edycje

`lib/agent-transport.js`, `lib/agent-harness/types.js`,
`lib/agent-harness/registry.js`, `lib/agent-harness/builtin-harness-providers.js`,
`lib/agent-harness/harness-plan-policy.js`, `lib/agent-harness/tool-definitions.js`,
`lib/agent-harness/openrouter-agent-loop.js`, `lib/ws/ws-router.js`,
`lib/sdk/sdk-ws-handshake.js`, `lib/harness-status.js`, `lib/harness-enabled.js`,
`lib/harness-catalog.js`, `lib/persist/settings.js`,
`lib/persist/chats-persist.js`, `lib/routes/settings-routes.js`,
`lib/routes/chats-routes.js`, `lib/register-app-routes.js`,
`lib/delegation-executor.js`, `lib/delegation-adapter-capabilities.js`,
`lib/delegation-run-bridge.js`, `lib/usage/usage-contract.js`,
`lib/usage/usage-event.js`, `lib/usage/usage-normalize.js`,
`lib/usage/harness-usage.js`,
`lib/workspace-scout-read-only.js`, `lib/recovery/recovery-contract.js`,
`lib/model-catalog-meta.js`, `lib/model-score-heuristics.js`,
`lib/model-role-profiles.js`, `lib/notices.js`, `lib/chat-title-providers.js`,
`lib/spa-routes.js`, `lib/mcp/adapters/index.js`,
`lib/mcp/mcp-openrouter-tools.js`, `lib/mcp/builtin/delegation-tools.js`,
`package.json`, `.env.example`.

### Frontend — nowe

`app_front/mistralModelSettings.js`, `public/harness-icons/mistral.svg`.

### Frontend — edycje

`public/index.html` (taby, subtaby, sekcje Keys/Models/Stats, statyczny
`#chat-new-harness-select`), `app_front/App.js`, `app_front/chat.js`,
`app_front/harnessSettings.js`, `app_front/lanSettings.js`, `app_front/api.js`,
`app_front/features/chat/sdk-transport-labels.js`,
`app_front/features/chat/chatTransport.js`,
`app_front/features/chat/chatModelSelect.js`,
`app_front/features/chat/harnessModelUsage.js`,
`app_front/features/chat/harnessSettingsLoad.js`,
`app_front/features/chat/newChatHarnessStatus.js`,
`app_front/features/chat/sdkStateResolver.js`,
`app_front/features/chat/sdkRunOutcomeRecovery.js`,
`app_front/features/setup/firstRunSetup.js`,
`app_front/components/chat/cr-sdk-mode-bar.js`,
`app_front/features/sidebar/sidebarView.js`,
`app_front/features/sidebar/sidebarChatRowModel.js`,
`app_front/features/settings/mcpSettings.js`,
`app_front/features/usage/usageSettings.js`,
`app_front/features/voice/voiceHarnessMatch.js`,
`app_front/features/voice/realtimeTools.js`,
`app_front/features/watcher/scoutProfileEditorView.js`,
`app_front/lib/sdk-rich-view.js`, `app_front/i18n/en.js`,
`app_front/i18n/pl.js`.

**Świadomie bez zmian:** `app_front/features/usage/usageCharts.js`
(`SUBSCRIPTION_HARNESSES`), `app_front/config.js`, `app_front/lib/sdk-chat-format.js`.

---

## 6. Plan testów

### Testy jednostkowe (nowe, `node --test`/`node tests/...`)

| Plik | Co sprawdza |
|------|-------------|
| `tests/mistral-api-key.test.js` | env > settings, meta bez wycieku klucza, clear |
| `tests/mistral-models.test.js` | fallback lista, mapowanie payloadu `GET /v1/models`, normalizacja enabled |
| `tests/mistral-client.test.js` | normalizacja chunków SDK → `deltaText`/`toolCallDeltas`/`finishReason`/`usage`/`error` (na atrapie SDK) |
| `tests/optional-mistral-sdk.test.js` | brak pakietu nie wywraca importu; `isMistralSdkAvailable()` = false |
| `tests/mistral-harness-flow.test.js` | room + adapter: start/cancel/getState, eventy `sdkBusy`/`sdkRunFinished` (atrapa `streamChatCompletion`) |

### Testy do aktualizacji

`tests/harness-status.test.js`, `tests/sdk-transport-labels.test.js`,
`tests/model-catalog.test.js`, `tests/chats-persist-harness.test.js`,
`tests/harness-plan-policy.test.js`, `tests/sdk-ws-handshake.test.js`,
`tests/e2e/chat-mock.spec.js`, `tests/spa-routes.test.js`,
`tests/widget-chat-scope.test.js`.

### `package.json`

- nowe skrypty: `test:mistral-api-key`, `test:mistral-models`,
  `test:mistral-client`, `test:optional-mistral-sdk`;
- dodać je do łańcucha `test:without-cursor-sdk`.

### Testy live (opcjonalne, za `MISTRAL_API_KEY`)

- `tests/live/mistral-tool-call.test.js` — realny stream + jedno wywołanie
  narzędzia (`read_file`), weryfikacja drugiej tury z `tool` result.
- `npm run test:e2e:live:mistral` (Playwright, wzorzec
  `tests/e2e/chat-live-harnesses.spec.js`).

---

## 7. Ryzyka i pytania otwarte

| # | Ryzyko / pytanie | Wpływ | Mitygacja |
|---|------------------|-------|-----------|
| R1 | `delta.toolCalls` jest camelCase, a pętla czyta `delta.tool_calls`; `function.arguments` bywa obiektem | **potwierdzone** | klient normalizuje camelCase→snake_case i `arguments`→string; typy zweryfikowane z tarballa 2.7.0 |
| R2 | `finishReason: 'tool_calls'` a pętla sprawdza `'stop'` po wykonaniu narzędzi — możliwy przedwczesny `completed` | średni | Pętla i tak kończy, gdy `pendingToolCalls` puste; dodać test końca tury z narzędziami; zmapować `finishReason: 'error'` na błąd |
| R3 | `zod`/`zod-to-json-schema` w drzewie (SDK importuje `zod/v4`) | niski | `optionalDependency`; sprawdzić `npm ls zod` |
| R4 | SDK niedostępne w Termux | niski | SDK jest czysto JS (ES2020+, Fetch/Streams), wspiera Node 20/22; potwierdzić w Fazie 0 |
| R5 | Modele bez tool calling / vision; deprecacje (`devstral-*`, `magistral-*`) | średni | `models.list()` → `capabilities.functionCalling/vision`; runtime resolution aliasów; ostrzeżenie przy obrazie |
| R6 | Dodanie transportu zmienia semantykę „pełnego zbioru” w `normalizeEnabledHarnesses` (użytkownicy z zapisanym pełnym zbiorem) | średni | `AGENT_TRANSPORTS.length` rośnie; pełny zapis nadal = wszystkie; test migracyjny |
| R7 | `runOpenRouterAgentLoop` refaktor psuje OpenRouter | wysoki | Zostawić wrapper + istniejące testy; refaktor osobnym commitem |
| R8 | Mistral Agents API kusi, ale dubluje stan | średni | Świadomie poza MVP; udokumentować |
| R9 | Rate limit 429 bez mapowania na UI | niski | `noteHarnessUsageLimit` + `sdkError` code `mistral_rate_limit` |
| R10 | Recovery: brak `canResumeSession` | niski | Deferred adapter, jak `openrouter` |

Pytania do decyzji produktowej:

1. Czy `mistralBaseUrl` (self-hosted / sovereign) ma być w MVP?
2. Czy obrazy (modele vision: Large 4 / Medium 3.5) w MVP, czy faza 2?
3. Czy auto-title przez Mistral ma być providerem (`AUTO_TITLE_PROVIDER_IDS`)?
4. Czy domyślny model to `mistral-medium-latest` (agentowy), czy
   `mistral-large-latest` (trudne zadania / 1M kontekstu)?

### 7.1 Pułapki i kolejność (zweryfikowane w kodzie)

- **Kolejność ma znaczenie:** najpierw wpis w `harness-plan-policy.js`
  (`mistral`), potem podpięcie pętli. `getToolsForMode` (linia 159) twardo
  woła `resolveHarnessReadOnlyPolicy('openrouter', ...)`; bez wpisu dla
  `mistral` i bez przekazania transportu `resolveHarnessPlanPolicy` zwróci
  `undefined` i rzuci.
- **`buildAgentHelloPayload`** (`lib/sdk/sdk-ws-handshake.js:23`) ma
  whitelistę transportów — pominięcie `'mistral'` degraduje hello do
  `transport: 'cursor-sdk'` i psuje etykiety/stan.
- **Adapter czatu rejestruje się jako side effect importu**
  `lib/mistral/mistral-agent-ws.js`. Produkcyjnie wystarczy import w
  `lib/ws/ws-router.js`; testy importują adapter jawnie.
- **`GET /api/harnesses` jest już zarejestrowane w `openrouter-routes.js`
  (linia 18)** — nie duplikować w `mistral-routes.js`.
- **`listHarnessModels` nie ma generycznego live-fetchu** — bez brancha
  `mistral` w `lib/harness-catalog.js` zwróci ostrzeżenie „No cached catalog”
  i tylko wiersze z Settings.
- **`/api/chats` tworzenie** ma siedem miejsc wyliczających transporty (importy,
  `status-tail`, `/diag`, `/dispose-sdk-room`, gate credentials + `defaultTitle`,
  `PATCH` model-sync, `DELETE` dispose). Łatwo pominąć `PATCH`/`DELETE`, co
  zostawi wiszący room.
- **`lib/harness-usage-limits.js` i `lib/mcp/mcp-config.js` NIE wymagają
  zmian** — są pochodne (`VALID_TRANSPORTS` / `listChatRunAdapterTransports()`).
- **Test `model-catalog`** zakłada zamkniętą listę transportów; dodanie
  `mistral` = aktualizacja asercji, nie tylko kodu.

---

## 8. Szacowany nakład

| Faza | Zakres | Czas |
|------|--------|------|
| 0 | spike SDK | 0.5 d |
| 1 | transport + pętla + WS | 1–1.5 d |
| 2 | modele + klucz + trasy | 0.5–1 d |
| 3 | frontend + i18n | 1.5–2 d |
| 4 | delegacje/MCP/usage/scout/recovery | 1 d |
| 5 | testy | 0.5–1 d |
| 6 | docs + changelog | 0.25 d |
| **Razem** | | **~5.25–7.25 d** |

Największy dług to nie kod Mistrala, a przejście checklisty miejsc
wyliczających transporty (backend ~30 + frontend ~25 plików) i testy regresji.
Frontend (`chat.js`, `chatModelSelect.js`, `public/index.html`,
`lanSettings.js`) to najbardziej rozproszona część i główne źródło pominięć.
