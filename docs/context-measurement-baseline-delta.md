# Baseline delta — pomiar kontekstu

**Data weryfikacji:** 2026-10-13  
**HEAD (worktree liścia `26a66451`):** `6cd551a7e4708a5fb14334d4f881e3696ff8d591`  
**Baza porównawcza (TODO źródłowe):** [fbaedde9-0a31-486d-9426-94e9cffd0088](fbaedde9-0a31-486d-9426-94e9cffd0088) — snapshot kodu `79b8329dc13c69e5b2fb5b1cd209f2f7558a9a0b` (+ lokalne `e0955326` z opisu karty).  
**Plan nadrzędny:** [3e602ab5-ccd9-454b-9785-90a8a54654f9](3e602ab5-ccd9-454b-9785-90a8a54654f9) — integracja pomiaru kontekstu.

Ten dokument **nie powtarza** pełnej inwentaryzacji z `fbaedde9`. Opisuje wyłącznie **delty** od snapshotu oraz aktualny status punktów OTWARTE z cytatami `plik:linia`.

---

## Delta od snapshotu `79b8329` → HEAD `6cd551a7`

| Obszar | Zmiana względem snapshotu | Wpływ na OTWARTE |
| --- | --- | --- |
| Lookup okna modelu | `getModelContextParamWindowTokens` + prefiksy Claude 5 w `lib/sdk/sdk-context-advisory.js:62-73`, `102-108`, `111-118`; testy w `tests/sdk-context-stats.test.js:23-26` | Ulepsza SDK/Cursor warianty `::context=`, **nie** zamyka braku `(harness, modelId)` |
| Estymacja w UI | `estimateTokensFromText` zamiast `chars/4` w `app_front/features/chat/chatContextMeter.js:32` | Kosmetyka estymacji; bramkowanie autokompresji bez zmian |
| OpenCode — live usage | `noteOpenCodeUsageFromEvent` → `sdkEvent` `type: 'usage'` w `lib/opencode/opencode-agent-ws.js:596-607`; adapter `lib/opencode/opencode-usage.js`; test `tests/opencode-usage-telemetry.test.js` | Częściowy postęp względem tezy „brak usage”; **docs/ARCHITECTURE.md:338** nadal mówi odwrotnie |
| Frontend — odbiór usage | Obsługa `msg.event.type === 'usage'` dla dowolnego transportu w `app_front/features/chat/chatTransport.js:1498-1510` | OpenRouter / inne pętle z `llm-tool-loop` mogą zasilać licznik, gdy API zwróci `usage` |
| Macierz kontraktu | Nowe wiersze `mistral`, `zai`, `mimo` (+ istniejący `voice`) w `lib/usage/usage-contract.js:351-424`; test „eleven harnesses” w `tests/usage-contract.test.js:56-68` | Rozszerza ledger; **poza** pierwotnymi „7 harnessów” z `fbaedde9`; `voice` nadal poza testem macierzy chat |
| Podsystem usage (skrót) | Duży przyrost modułów/testów (`usage-window`, `usage-acceptance-*`, `context-restarts`, `plan-window-forecast`, …) — ~92 pliki w torze usage/context od baseline | Wspiera billing/plan limits i restarty sesji; **nie** zastępuje OTWARTE 1–3 w metrze czatu |
| Dokumentacja kontekstu | `docs/ARCHITECTURE.md:333-338` — nadal reguła `input - cacheRead` i brak usage OpenCode/OpenRouter | OTWARTE 5 bez poprawki tekstu |

**Brak diffu** (od baseline) w logice: `maybeScheduleAutoContextCompression`, bramka `agentTransport !== 'sdk'` sync diag, sygnatura `getModelContextWindowTokens(modelId)` bez harnessu.

---

## WYMAGA DECYZJI CZŁOWIEKA (do planu `3e602ab5`)

Mechanizm `accountingScope` (`own` \| `consolidated`) jest w kontrakcie (`docs/usage-contract.md:23`, `lib/usage/usage-contract.js` — pola macierzy). **Nierozstrzygnięte:** czy consolidated usage dziecka wchodzi w occupancy/billing rodzica w UI i w progach autokompresji. Karta `fbaedde9` krok 9 i `3e602ab5` wymagają **jawnej decyzji produktowej** przed implementacją granicy billingu; ten liść **nie** zmienia zachowania.

---

## Status punktów OTWARTE (weryfikacja HEAD)

### OTWARTE 1 — lookup `(harness, modelId)`

**OTWARTE.** `getModelContextWindowTokens(modelId)` przyjmuje tylko `modelId`: `lib/sdk/sdk-context-advisory.js:102-104`. Dynamiczne okna: `setDynamicModelContextWindows` (`lib/sdk/sdk-context-advisory.js:80-95`), wywołania m.in. `app_front/features/chat/chatModelSelect.js:314`. Prefiksy nadal współdzielone między harnessami o tej samej nazwie modelu.

### OTWARTE 2 — autokompresja bez `isEstimated`

**OTWARTE.** `maybeScheduleAutoContextCompression` sprawdza wyłącznie enabled/pending/running/próg: `app_front/chat.js:8883-8892`; bramka transportu SDK: `app_front/chat.js:8895-8897`. `updateChatContextMeter` woła autokompresję z `snapshot.fillPercent` bez `isEstimated`: `app_front/features/chat/chatContextMeter.js:253`. Panel szczegółów **pokazuje** exact vs estimated (`app_front/chat.js:9251-9254`), ale **nie blokuje** harmonogramu.

### OTWARTE 3 — resume/stale TTL; sync tylko SDK

**OTWARTE (częściowo).** Tło sync usage diag: `startChatContextUsageSync` → `if (chat.agentTransport !== 'sdk') return` — `app_front/features/chat/chatDiagnostics.js:171-171`; interwał `CHAT_CONTEXT_USAGE_SYNC_MS` (30 s): `:13`, `:185`. Polling diag (`startChatDiagPolling`) **nie** ma bramki SDK: `app_front/features/chat/chatDiagnostics.js:248-265` — dotyczy panelu diag, nie zastępuje sync occupancy dla innych harnessów. Brak TTL >2× interwału i odrzucania po zmianie modelu/epoki w tym torze (zgodnie z `fbaedde9`).

### OTWARTE 4 / 5 — OpenCode/OpenRouter vs ARCHITECTURE; reguła fill %

**OTWARTE (4 — częściowo zamknięte w kodzie, docs nieaktualne).**  
- OpenCode: ścieżka live usage w kodzie (patrz delta).  
- OpenRouter: emisja `{ type: 'usage' }` z pętli narzędzi `lib/agent-harness/llm-tool-loop.js:208-213`.  
- **Docs:** `docs/ARCHITECTURE.md:333-334` — „Fill % uses effective input (`input - cacheRead`)”; `docs/ARCHITECTURE.md:338` — „OpenCode/OpenRouter rooms do not currently emit `usage` events”.  
- **Kontrakt okna:** `promptTokensForWindow` sumuje input + cache read + write: `lib/usage/usage-contract.js:586-593` — sprzeczność z ARCHITECTURE § context meter.

### OTWARTE 6 — UI: wiek i typ limitu (kontekst vs zużycie)

**OTWARTE.** Metr czatu: `updatedAt` i exact/estimated w snapshot (`app_front/features/chat/chatContextMeter.js:146-165`, szczegóły `app_front/chat.js:9266`). **Brak** jawnego wieku/typu limitu okna kontekstu w pasku metra (w przeciwieństwie do kart plan limits w Settings: `rateLimitType`, `observedAt`, `stale` — `app_front/features/usage/planLimitsView.js:15-21`, `:24`).

### OTWARTE 7 — macierz testów per harness (stale, kolejność, prompt > okno)

**OTWARTE.** Od baseline przybyły m.in. `tests/usage-acceptance-*.test.js`, `tests/context-restarts.test.js`, rozszerzone telemetry — **bez** pełnej matrycy przypadków z kroku 11 `fbaedde9` (stale TTL occupancy, odpowiedzi poza kolejnością, prompt > okno per harness w UI+serwer).

---

## `context-restarts.js` i `plan-window-forecast.js` a OTWARTE 1 / 3

| Moduł | Rola | OTWARTE 1 | OTWARTE 3 |
| --- | --- | --- | --- |
| `lib/usage/context-restarts.js` | In-memory rejestr restartów sesji (MCP/model/mode) — `CONTEXT_RESTART_REASON`, limity `:30-33` | **Nie** — nie kluczuje lookup okna | **Nie** — nie implementuje TTL/stale dla `_contextUsageUpdatedAt`; tylko invalidation listenery `:67-73` |
| `lib/usage/plan-window-forecast.js` | Prognoza okien **plan limits** (utilization billing), `PLAN_WINDOW_STALE_MS` `:17` | **Nie** | **Nie** — inny produkt niż metr occupancy czatu |

---

## Rozbieżności integracyjne (do naprawy w integracji, nie w tym liściu)

1. **Rewizja kontraktu:** `docs/usage-contract.md:3` — `2026-10-06.3`; kod `USAGE_CONTRACT_REVISION = '2026-10-06.2'` — `lib/usage/usage-contract.js:29`. Nie podbijać rewizji ani nie przepisywać kontraktu w tym zadaniu.
2. **Liczba harnessów w docs vs kod:**  
   - Tabela w `docs/usage-contract.md:48-57` — **8** wierszy chat + `voice` opisany osobno (`:59-60`).  
   - Sekcja 7 mówi o **„nine harnesses”** (`docs/usage-contract.md:172`).  
   - `docs/ARCHITECTURE.md:120` — **„ten harnesses”** (chat).  
   - Kod: **12** kluczy w `USAGE_HARNESS_MATRIX` (11 chat + `voice`); test wymaga **11** bez `voice` (`tests/usage-contract.test.js:56-68`).  
   Ujednolicić przy integracji `510dcafc`, bez zmiany adapterów w tym liściu.

---

## Potwierdzona lista OTWARTE (skrót)

1. Lookup okna bez `(harness, modelId)` — **OTWARTE**  
2. Autokompresja bez bramki `isEstimated` / stale / epoch — **OTWARTE**  
3. Sync occupancy diag SDK-only; brak TTL occupancy — **OTWARTE**  
4. Parytet live usage OpenCode/OpenRouter — **częściowo w kodzie**, docs **OTWARTE**  
5. ARCHITECTURE fill % vs `promptTokensForWindow` — **OTWARTE**  
6. UI wiek/typ limitu kontekstu — **OTWARTE**  
7. Pełna macierz testów occupancy per harness — **OTWARTE**  
8. Rewizja docs/kod + liczba harnessów w dokumentacji — **do integracji**  
9. Granica billingu (`accountingScope`) — **WYMAGA DECYZJI CZŁOWIEKA**

---

## Artefakt

- Utworzono: `docs/context-measurement-baseline-delta.md` (ten plik).  
- Kod adapterów i `USAGE_CONTRACT_REVISION`: **bez zmian** (zgodnie z zakresem liścia).  
- Testy: **nie uruchamiano** (zmiana wyłącznie dokumentacyjna).
