# Niezależny przegląd integracji — UI freeze / replay historii (etapy 0–4)

- Data: 2026-10-06
- Autor: executor-implementator (liść 5.1 drzewa `33e307a2-741d-4ec1-94d4-2aa0a94616bb`)
- Zakres: nowe/zmienione obszary etapów 0–4 (replay lifecycle, generation gate,
  replay result/coverage, hydratacja live, viewport batching, akumulacja raportów,
  preview raportów, okno historii) oraz ich integracja z `chat.js`.
- Cel: sprawdzić race local/HTTP/live, anulowanie/finally, grupy tur,
  dostępność pełnych danych i reguły `historySeq`/`roomEventSeq`; naprawić realne
  uwagi w zakresie etapów 0–4.

## Metoda

Przegląd kodu źródłowego (bez zgadywania): odczyt modułów replay i guardów,
porównanie ścieżek sync/instant/chunked, analiza `finally`/`catch` i kolejności
`await`. Weryfikacja testami uruchamianymi lokalnie oraz przez
`node scripts/review-verify.js`. Uwaga naprawiona i pokryta testem regresyjnym.

## Sprawdzone obszary i wnioski

### 1. Race local / HTTP / live — OK

- `chat.js` (`openChatTerminal`, ok. 4880–5034): kolejność to local cache →
  HTTP (`pullChatHistoryFromServer`) → SDK API fallback → local store fallback.
  Każdy kolejny etap jest blokowany przez `structuredReplayDone`, więc nie ma
  podwójnego renderu (double-restore).
- `captureHydrationHttpBoundary` jest robiony **przed** wolnym pullem HTTP, a
  `isHydrationHttpBoundaryCurrent` sprawdzany **po** pullu i po każdym `await`
  w `mergeServerSdkHistoryIntoRichView`. Zamiana panelu/sesji unieważnia wynik
  (`staleHttp`), a `chat.js` nie nadpisuje wtedy wyniku hydratacji lokalnej.
- `mergeServerSdkHistoryIntoRichView` czeka na `waitForHistoryReplaySettled(chat)`
  przed nałożeniem historii HTTP, więc HTTP nie ściga się z trwającym replayem.
- Live WS w czasie hydratacji/replaya jest buforowane
  (`bufferLiveEventDuringHistoryReplay`, `_sdkPendingRoomEvents`) i opróżniane
  w `finally` `trackHistoryReplayPromise` — bez zgubienia i bez podwójnego
  zastosowania.
- Tryb merge (`catch_up` vs `replace`) zależy od `structuredReplayDone` **oraz**
  `hasSdkHistoryRoomWatermarks`. Brak watermarków (typowy lokalny snapshot IDB
  bez `eventStreamId`) wymusza `replace`, co jest bezpieczniejsze.

### 2. Anulowanie / `finally` — JEDNA UWAGA NAPRAWIONA

**Znalezisko (realne):** ścieżka błędu `replayHistoryRecords` nie domykała
`replayOutcomeByGeneration`. Wyjątek z `applyHistoryRecord`/finalize był
przechwytywany w `runHistoryReplayAsyncTail` (lifecycle dostawał `reason:'error'`),
ale widokowy `settleReplayOutcome(gen, 'error')` **nigdy** nie był wołany, a
`void (async () => {…})()` nie miało `.catch`. Skutki:

1. `replayPromise` (zwracane przez `replayHistoryRecords` i `replaySdkRichViewHistory`)
   nigdy się nie rozwiązywał.
2. `waitForHistoryReplaySettled(chat)` wisiał → `finally` w `openChatTerminal`
   (linia 5022) nie dobiegał końca: `completeSdkHistoryHydration`,
   `clearSdkOpenTerminalHydrating`, `ensureChatConnection` nie były wołane.
3. Powstawał unhandled rejection z fire-and-forget async tail.
4. Typ `HistoryReplayFinishReason` zawiera `'error'`, ale żadna ścieżka go nie
   produkowała — co potwierdza przeoczenie, nie zamierzenie.

**Naprawa:** `app_front/lib/sdk-rich-view.js` — do fire-and-forget IIFE w
`replayHistoryRecords` dodano `.catch`, który:
`historyReplayLifecycle.finishReplay(gen, {reason:'error', …})`,
`settleReplayOutcome(gen, 'error')` oraz log `appLogger`
(`'sdk-rich-history'`, `'history replay failed'`). `settleReplayOutcome` jest
idempotentne, więc nie ma podwójnego rozstrzygnięcia przy supersede/destroy.

**Test regresyjny:** `tests/chat-history-mounted-window.test.js` →
`a throwing apply settles the replay outcome as error (Chromium)` — wymusza
deterministyczny wyjątek w `applySdkEvent` (niewyliczalny getter `event.type`,
który przechodzi `structuredClone`/JSON) i asercją `Promise.race` dowodzi, że
wynik dochodzi z `reason:'error'`, `cancelled:false`, `applied:0`, bez
`pageerror`. Bez naprawy test kończy się `TIMEOUT`.

### 3. Grupy tur — OK

- `lib/sdk/sdk-history-turn-window.js`: okno i strony są wyrównywane do granicy
  tury użytkownika (`user`/`localUser`). `resolveTurnAlignedStartIndex` szuka
  granicy wstecz, a gdy jej brak — w przód; ostateczny fallback to 0 (cała
  historia), więc nie oddziela Activity tray od otwarcia runu.
- `buildHistoryTurnSegment` poprawnie liczy `partIndex`/`partCount`
  (`min(partCount, floor(offset/cap)+1)`) i `includesTurnOpen` tylko dla offsetu 0.
- `isHistoryRunFragmentRecord` odróżnia fragmenty runu od samodzielnych meta
  (watcher/notice), więc strona samych meta nie jest wstrzymywana.

### 4. Dostępność pełnych danych (coverage/ACK) — OK

- `noteViewAppliedRecords` przesuwa watermark tylko po **spójnym prefiksie**
  (`resolveContiguousAppliedSeq`); live karta przy seq 102 nie ukrywa brakującego
  101.
- `replaceViewAppliedRecords` (pełny replay/hydratacja) czyści zbiór i origin
  przed ponownym naliczeniem.
- `collectMissingSdkHistoryRecords` z `commit=false` nie mutuje stanu czatu;
  commit (`takeMissingSdkHistoryRecords`) następuje dopiero po udanym renderze.
  Serwerowe meta (`delegation`/`mailbox`/`relatedChat`) i `localUser` są zawsze
  brane, a ich `noteRenderedSdkRoomEvent` jest no-opem (brak seq) — nie nadpisują
  watermarku room.
- `hasUnrenderedSdkRoomEventSeq` blokuje „zakrycie dziury” po nieudanym apply.

### 5. Reguły `historySeq` / `roomEventSeq` — OK

- `chatHistoryViewOrder.js`: `historySeq` to trwały porządek rozmowy; `roomEventSeq`
  jest porównywalny **tylko** w obrębie tego samego `eventStreamId`. Dwa
  namespace'y nigdy nie są mieszane; `compareViewOrderKeys` zwraca 0
  (nieporównywalne) zamiast zgadywać. `isSameViewOrderKey` celowo nie używa
  `compareViewOrderKeys`, bo 0 oznacza też „nieporównywalne”.
- `sdkEventReplayGuard.js`: watermarki per-stream (`_sdkHydratedRoomEventSeqByStream`)
  plus `_sdkLastRoomEventSeq` dla bieżącego streamu; `syncSdkEventStream`
  resetuje watermark przy nowym pokoju, zachowując hydrated seq dla tego samego
  streamu.
- `mergeParkedHistoryRecords` deduplikuje po `isSameViewOrderKey` i sortuje po
  `historySeq`, a przy nieporównywalności zachowuje kolejność lewej listy
  (bez przestawiania).

### 6. Generation gate i lifecycle — OK (z drobną uwagą)

- `createChatHistoryReplayGenerationGate`: `activate`/`revoke` czyszczą
  zaplanowane klatki i merged work; `scheduleGuardedScroll` odrzuca nieaktywne
  generacje (`generation 0` = live, zawsze przechodzi).
- `runHistoryReplayAsyncTail`: `finally` zawsze woła `lifecycle.finishReplay`
  z ustalonym `resolvedReason` (`cancelled` przy przerwanym apply, `error` przy
  wyjątku); finalize jest pomijany, gdy anulowano.
- `chatHistoryReplayLifecycle`: supersede zamyka poprzedni span jako
  `superseded`; `finishReplay` dla starej generacji bumpuje `staleCompletes`;
  `onViewDestroyed` zamyka span jako `destroyed`.
- Pary `beginHistoryReplayApplySlice`/`endHistoryReplayApplySlice` są wołane
  w `onSliceStart`/`onSliceEnd`, więc flagi `suppress*` są podniesione tylko
  w trakcie synchronicznego apply; dodatkowe `end…` w `finally` nie psują
  nowszej generacji, bo między slice'ami flagi i tak mają być zdjęte
  (JavaScrypt jest jednowątkowy, więc slice nowszej generacji nie przecina się
  z domknięciem starszej).

## Uwagi odłożone (poza zakresem / niski priorytet)

1. `closedSpanReasonByGeneration` w `chatHistoryReplayLifecycle` rośnie o jeden
   wpis na replay i jest czyszczony tylko w `reset()` (test seam). Dla bardzo
   długiej sesji to niewielki, ograniczony wyciek pamięci — nie wpływa na
   poprawność. Do rozważenia przy okazji sprzątania lifecycle, nie w tym liściu.
2. `applyHistoryRecord` robi `cloneHistoryRecordForParking(record)` **przed**
   `try`, a `finally` przywraca wskaźniki renderowania dopiero po clone. Gdyby
   clone rzucił (uszkodzony rekord), wskaźniki `renderedRecord*` zostałyby
   wskazane na zły rekord. Przy normalnych rekordach clone nie rzuca; realny
   wpływ znikomy. Odłożone (nie jest to regresja etapów 0–4).
3. `runHistoryReplayApplySlices` mierzy `applyMs` zegarem `monoNow()`, a budżet
   `deps.now()` — celowe (dwa różne zegary: diagnostyka vs pacing); brak akcji.

## Niepowiązane, istniejące failures

- `tests/sidebar-delegation.test.js` → subtest
  `partial rebuild preserves scroll position and keyboard focus` (exit 1).
  Asercja `assert.match(renderBody, /body\.scrollTop = scrollTop/)` jest
  nieaktualna: w working tree trwa **osobny** rewrite sidebara — logika
  przywracania scrolla została przeniesiona do
  `scheduleSidebarFocusAndScrollRestore` (`sidebarView.js` linia ~1931/2059,
  `body.scrollTop = scrollTop` w linii ~2064). W `HEAD` (53551b9) ta linia była
  w `renderPassBody` (linia 1903), więc to zmiana z rewrite'u sidebara, a nie z
  etapów 0–4 (żaden moduł replay/hydratacji nie dotyka `sidebarView.js`).
  Zachowanie produktu (przywracanie scrolla) nadal istnieje — tylko asercja
  tekstowa jest nieaktualna. **Nie naprawiano** (poza zakresem liścia;
  „nie osłabiać asercji”).

## Ograniczenia przeglądu

- Przegląd był statyczny + testowy; nie uruchamiano pełnego e2e z prawdziwym
  serwerem/WS (brak takiego harnessu w tym środowisku).
- Testy wymagające przeglądarki (`chat-history-mounted-window`,
  `ui-freeze-delegation-report-preview`, `delegation-history-card-report-no-buffer.mjs`)
  przechodzą lokalnie (system Chromium), ale **nie są** wpisane do
  `REVIEW_VERIFY_CATALOG` — patrz raport liścia 5.1, sekcja „review-verify”.
