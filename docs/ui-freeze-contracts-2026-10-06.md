# UI freeze — kontrakty kolejności, coverage i budżety (liść 0.2)

Data: 2026-10-06. Workspace: `/path/to/cretli`. Rodzic todo:
`33e307a2-741d-4ec1-94d4-2aa0a94616bb`. Poprzednik: baseline replay
(`docs/ui-freeze-baseline-2026-10-06.md`, liść 0.1). Diagnoza:
`docs/ui-freeze-trace-2026-10-06.md`.

**Cel liścia 0.2:** spisać kontrakty oparte na bieżącym kodzie, liczby
regresji i scenariusze pomiarowe. Implementacja egzekucji — etapy 1–5.
Stałe eksportowane: `app_front/lib/uiFreezeRenderBudgets.js`.

## Słownik

| Termin | Znaczenie |
| --- | --- |
| **Store ACK** | `acknowledgeChatHistorySeq` po ingest — persystencja wie, co dotarło z serwera |
| **View coverage** | `viewAppliedSeq` / `viewAppliedSeqs` — co widok **uznał** za zastosowane (ciągły prefiks) |
| **History coverage** | Zestaw tożsamości rekordów znanych modelowi (`resolveHistoryRecordIdentity`), niezależnie od DOM |
| **Mounted DOM** | Fizyczne karty w `#sdk-rich-view` / sidebarze |
| **Hydration complete** | `completeSdkHistoryHydration` + `_sdkHistoryHydrating === false` |

**Zasada:** store ACK ≠ view coverage ≠ wyrenderowanie. Badge „pending history”
znika dopiero gdy `viewAppliedSeq` dogoni `headSeq` (`chatHistorySyncPoll.js`).

## Budżety liczbowe (kontrakt docelowy)

| Stała | Wartość | Uzasadnienie |
| ---: | ---: | --- |
| `UI_FREEZE_SLICE_BUDGET_MS` | **8** | Porcja sync przed yield (`schedulerYield.js`) |
| `UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS` | **8** | Koszt apply 8 rekordów przed rAF (obecnie tylko mierzone w diag) |
| `HISTORY_REPLAY_SYNC_HEAD` | **20** | Sync head replayu (`chatHistoryReplayLifecycle.js`) |
| `HISTORY_REPLAY_CHUNK_SIZE` | **8** | Rozmiar paczki async replay |
| `UI_FREEZE_REPAIR_PATH_TASK_MS` | **50** | Naprawione ścieżki (poll, boot-cache, archive harness) |
| `UI_FREEZE_INPUT_LATENCY_MS` | **200** | Latency interakcji (trace 2026-10-06: max **2448,8 ms** — regresja) |
| `UI_FREEZE_CHAT_HISTORY_INITIAL_TAIL` | **80** | Okno tail (`config.js`; turn alignment może rozszerzyć w obrębie tury) |
| `UI_FREEZE_CHAT_HISTORY_OLDER_PAGE` | **80** | Strona prepend (`CHAT_HISTORY_OLDER_PAGE`) |
| `UI_FREEZE_CHAT_MOUNTED_RECORD_CAP` | **80** | Docelowy limit kart w widoku po etapie 4 |
| `UI_FREEZE_SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS` | **64** | Sidebar archiwum (`sidebarArchiveVirtualizer.js`) |
| `UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES` | **16 384** | Podgląd karty delegacji/mailbox (etap 3; trace: ~800 KiB pełny raport) |
| `UI_FREEZE_CHAT_DOM_NODES_SOFT_CAP` | **120 000** | Docelowy soft cap nodes aktywnego czatu po 3+4 |
| `UI_FREEZE_TRACE_REGRESSION_DOM_NODES` | **509 961** | Sufit regresji z trace 2026-10-06 |
| `UI_FREEZE_TRACE_REGRESSION_LAYOUT_OBJECTS` | **276 323** | Sufit `Layout.totalObjects` z trace |

Fixture reprezentatywny: `tests/fixtures/synthetic-history-replay-records.json` —
**52** rekordy, max rekord **819 311** B UTF-8 (JSON), suma **824 255** B.

**Wyjątek świadomy (etap 2 vs 3):** pomiar ≤50 ms na ścieżkach naprawionych
dotyczy fixtures z prozą w limicie podglądu. Scenariusz **800 KiB** + native
`Commit` rozlicza etap **3.2** i odbiór **5.2** — nie oznacza PASS całej
strony przed podglądem.

**Długa tura / duży rekord:** yield co 8 rekordów **nie** dzieli pojedynczego
`applyHistoryRecord`; jeden rekord może przekroczyć 8 ms i 50 ms do etapu 3
(preview) i 1 (generacja / anulowanie).

---

## Kontrakty — tabela główna

| Kontrakt | Inwariant | Egzekucja (plik) | Test / miara |
| --- | --- | --- | --- |
| **C-ORDER-01** `historySeq` | Globalna kolejność trwała w obrębie czatu; porównanie tylko gdy oba > 0 | `chatHistoryViewOrder.js` (`compareViewOrderKeys`), `sdk-rich-view.js` (`runViewApplyWithOrder`) | `tests/chat-history-view-order.test.js` |
| **C-ORDER-02** `roomEventSeq` | Porównywalne tylko w tym samym `eventStreamId`; brak id → brak wymyślonej kolejności room | `chatHistoryViewOrder.js`, `resolveEventStreamId` | j.w. |
| **C-ORDER-03** Tożsamość karty | Ten sam rekord = ten sam `historySeq` albo `(stream, roomEventSeq)` | `isSameViewOrderKey`, `findExistingViewOrderIndex` | j.w. |
| **C-ORDER-04** Wstawianie | Starszy `historySeq` wstawiany przed tail; `captureInsertScroll` tylko gdy potrzebna geometria (etap 2 ogranicza) | `sdk-rich-view.js` (~3600, ~1536) | Trace: `UpdateLayoutTree` ze stosu capture; test DOM etap 2 |
| **C-WATER-01** Room watermark | Po hydratacji: `_sdkHydratedRoomEventSeqByStream`, `_sdkLastRoomEventSeq` | `sdkEventReplayGuard.js` (`commitSdkHistoryHydration`, `hasSdkHistoryRoomWatermarks`) | Testy konwergencji / manual hydratacja |
| **C-WATER-02** Local bez stream id | Pusty watermark → merge HTTP **replace**, nie catch-up append | `chat.js` (`mergeServerSdkHistoryIntoRichView`, ~4220) | Integracja local→HTTP w `chat-history-replay-integration.test.js` (logika źródeł) |
| **C-RUN-01** Mapowanie runów | Run assistant powiązany z blokiem/stream; partial text przez akumulator (naprawa etap 3) | `sdk-rich-view.js`, `lib/sdk/harness-plan-sync.js`, `cursor-agent-sdk-ws.js` | `tests/sdk-history-stream-coalesce.test.js`, etap 3 |
| **C-RUN-02** Activity / Thinking | Grupowanie serii w jednej turze; replay nie rozcina grup przez izolację per rekord (etap 1/2) | `sdk-rich-view.js` (`withIsolatedRenderState`) | Trace + testy lifecycle etap 1 |
| **C-LIVE-01** Live w hydratacji | Zdarzenia live buforowane w `_sdkPendingRoomEvents` gdy `_sdkHistoryHydrating` | `sdkEventReplayGuard.js`, `chat.js` (~4834) | Testy etap 1.3 |
| **C-LIVE-02** Po hydratacji | `completeSdkHistoryHydration` odtwarza pending; live nie gubi seq | `chatTransport.js` (`completeSdkHistoryHydration`), guard | Konwergencja run |
| **C-LIVE-03** Flagi replay | `suppressHistoryPersist` / `suppressHooksPlain` / `mdRenderImmediate` — zakres właściciela replay (etap 1); nie blokować live poza replay | `sdk-rich-view.js` (~4499–5344) | Test generacji etap 1 |
| **C-LIFE-01** Generacja replay | Nowy replay dostaje wyższą generację; stary span `superseded` (diag) | `chatHistoryReplayLifecycle.js`, `sdk-rich-view.js` | `tests/chat-history-replay-lifecycle.test.js`, integration |
| **C-LIFE-02** destroy | `destroy()` czyści DOM; **obecnie** nie zatrzymuje async tail (znane — etap 1 naprawia) | `sdk-rich-view.js` (~4724), lifecycle `destroy` event | integration test (stale tail) |
| **C-LIFE-03** Scroll / focus | `armOlderSdkHistory`: 2× rAF po `scrollToBottom` przed sentinel; prepend zachowuje scroll (etap 2) | `chat.js` (`armOlderSdkHistory`), prepend w rich-view | Manual + etap 2 testy scroll |
| **C-PAGE-01** Starsze strony | `loadOlderSdkHistoryPage`: cache `_historyOlderLocal` potem `pullChatHistoryOlderFromServer`; **semantyka pagera serwera bez zmian** | `chat.js`, `sdk-chat-history-store.js` | Istniejące testy API historii |
| **C-PAGE-02** Prepend apply | Starsze rekordy przez `appendHistoryRecords` / prepend pass (instant dziś) | `chatHistoryViewApply.js`, `sdk-rich-view.js` | Etap 2 porcjowanie |
| **C-ACK-01** Store ingest ACK | `ingestChatHistoryDeltaResponse` ACK po normalizacji strony, **niezależnie od DOM** | `sdk-chat-history-store.js` (~1207) | `tests/sdk-chat-history.test.js` |
| **C-ACK-02** View watermark | `replaceViewAppliedRecords` / `noteViewAppliedRecords` — ciągły prefiks od `viewAppliedOrigin` | `chatHistoryConvergence.js` | Testy konwergencji (seq gaps) |
| **C-ACK-03** **Antywzorzec (stan obecny)** | Wywołanie `replaceViewAppliedRecords` **zaraz po starcie** replayu ustawia coverage przed końcem async | `chat.js` (~4201, ~4232) | **Do naprawy etap 1:** coverage po `noteViewAppliedRecords` per rekord lub po `async-end` |
| **C-ACK-04** Reset sesji | Zmiana `cursorSessionId` → `resetViewAppliedState`; store ACK zostaje | `chatHistoryConvergence.js` (`syncViewAppliedSessionKey`) | Test session boundary |
| **C-ACK-05** Final ack poll | Badge pending: `headSeq > viewAppliedSeq` mimo store ACK | `chatHistorySyncPoll.js` (`viewLag`) | `tests/chat-pending-remote-history.test.js` |
| **C-ACK-06** Wyjątek kontroli final ack | Ręczne „force read” / debug może tymczasowo ustawić view seq bez pełnego DOM — **tylko** z flagą diag, nie w produkcji | (plan etap 1 — jawna lista) | Logs + test feature flag |
| **C-DEDUP-01** Model dedupe | `dedupeHistoryRecords` po `resolveHistoryRecordIdentity` — **bez** odczytu DOM | `chatHistoryConvergence.js` | Testy konwergencji |
| **C-DEDUP-02** Catch-up | `applyCatchUpSdkHistoryRecords` pomija już znane seq/stream | `chatHistoryViewApply.js`, guard | Etap 1 scenariusz catch-up |
| **C-YIELD-01** Paczka replay | Co 8 rekordów: apply → await rAF (`chatHistoryReplayAsyncLoop.js`) | `chatHistoryReplayAsyncLoop.js` | lifecycle + integration |
| **C-YIELD-02** Instant replay | `{ instant: true }` wyłącza yield między rekordami (catch-up, local/http dziś) | `sdk-rich-view.js` (`replayHistoryRecords`) | **Etap 1:** instant nie omija budżetu dużego batcha |
| **C-YIELD-03** Slice hot paths | List/boot/monitoring: `DEFAULT_SLICE_BUDGET_MS` 8 | `schedulerYield.js`, `chatListServerReconcile.js` | `tests/chat-hot-path-slice.test.js` |
| **C-HYD-01** Koniec hydratacji | `_sdkHistoryHydrating` false dopiero po `commitSdkHistoryHydration`; `completeSdkHistoryHydration` na końcu ścieżki chat | `sdkEventReplayGuard.js`, `chat.js` (~5032) | Transport tests / manual |
| **C-HYD-02** Koordynacja | Po właściwej generacji: `completeSdkHistoryHydration` → `armOlderSdkHistory` → `syncRichViewPlainBuffer` w **jednym** właścicielu (etap 1) | `chat.js` | Scenariusz A→B→destroy |
| **C-DOM-01** Mounted records | Po etapie 4: ≤ `UI_FREEZE_CHAT_MOUNTED_RECORD_CAP` kart w streamie | (etap 4) | Playwright / trace nodes |
| **C-DOM-02** Sidebar archive | ≤ `UI_FREEZE_SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS` wierszy | `sidebarArchiveVirtualizer.js` | `tests/sidebar-archive-virtualizer.test.js` |
| **C-DOM-03** Preview delegacji | DOM preview ≤ 16 KiB UTF-8; pełna treść poza DOM | (etap 3) | Fixture 819 KiB + assert node count |
| **C-PERF-01** Naprawione ścieżki | Task sync ≤ **50 ms** (Node harness / instrumented span) | poll, boot-cache, slice | P0/P1/8.1 docs |
| **C-PERF-02** Input | Kolejka interakcji ≤ **200 ms** (docelowo; trace regresja 2448 ms) | cały main thread | Chrome trace etap 5 |

---

## Scenariusze pomiarowe (odtwarzalne)

| ID | Kroki | Metryki | Fixture / dane |
| --- | --- | --- | --- |
| **S-REPLAY-01** | Włącz `uiFreezeDiag=1`; otwórz czat; local replay → HTTP supersede | Spany `history-replay:*`, `batchMs`, `supersedes` | 52 rekordy syntetyczne |
| **S-REPLAY-02** | local → HTTP → szybki destroy | `stale-complete`, `destroy-async-complete`, counters | integration test Node |
| **S-SWITCH-01** | Czat A → B → A w <2 s | `activeAsyncLoops`, brak scroll jump (etap 1+) | Dowolny czat >20 rekordów |
| **S-CATCH-01** | Hydratacja local, potem delta HTTP z nowymi seq | catch-up vs replace (`hasSdkHistoryRoomWatermarks`) | Testy konwergencji |
| **S-PENDING-01** | Poll z `headSeq > ackSeq` i view lag | Badge pending do `viewAppliedSeq === headSeq` | `chat-pending-remote-history` |
| **S-OLDER-01** | Scroll do góry → prepend 80 | Jedna strona bez zmiany pagera serwera | `CHAT_HISTORY_OLDER_PAGE` |
| **S-NODE-01** | Replay fixture 52 + jeden rekord 819 KiB | `UpdateCounters.nodes`, max long task | Trace 5.2 / CDP |
| **S-SLICE-01** | `node scripts/measure-ui-freeze-baseline.mjs` | boot-cache, reconcile medians | 1500 wierszy syntetyka |
| **S-ARCH-01** | Otwarcie archiwum 1500–10000 wierszy | `sidebar.archive.render` span ≤50 ms | `sidebar-archive-virtual-*` |

Komendy baseline replay (Node):

```bash
node scripts/measure-history-replay-lifecycle-baseline.mjs
node tests/chat-history-replay-integration.test.js
```

Viewport referencyjny trace: **1920×525** (`docs/ui-freeze-trace-2026-10-06.md`).

---

## Powiązane pliki (indeks)

| Obszar | Pliki |
| --- | --- |
| Replay / DOM | `app_front/lib/sdk-rich-view.js`, `app_front/lib/chatHistoryReplayAsyncLoop.js`, `app_front/lib/chatHistoryReplayLifecycle.js` |
| Kolejność | `app_front/features/chat/chatHistoryViewOrder.js` |
| ACK / coverage | `app_front/features/chat/chatHistoryConvergence.js`, `app_front/lib/sdk-chat-history-store.js`, `app_front/features/chat/chatHistorySyncPoll.js` |
| Hydratacja / live | `app_front/chat.js`, `app_front/features/chat/sdkEventReplayGuard.js`, `app_front/features/chat/chatHistoryViewApply.js`, `app_front/features/chat/chatTransport.js` |
| Konwergencja | `app_front/features/chat/chatHistoryConvergenceRun.js` |
| Porcjowanie | `app_front/lib/schedulerYield.js` |
| Diagnostyka | `app_front/lib/uiFreezeTrace.js`, `app_front/lib/uiFreezeCounters.js`, `app_front/lib/chatPerfBudget.js` |
| Sidebar | `app_front/features/sidebar/sidebarArchiveVirtualizer.js` |
| Stałe 0.2 | `app_front/lib/uiFreezeRenderBudgets.js` |

---

## Ograniczenia liścia 0.2

- Kontrakty opisują **stan obecny + cele**; naprawa antywzorca C-ACK-03 i async
  invalidation to etap 1, nie ten liść.
- Limity DOM/preview są **zatwierdzone liczbowo**, egzekucja w etapach 3–4.
- Pełny odbiór Chrome (114 long tasks) pozostaje etapem 5; Node harness nie
  zastępuje `Commit` w przeglądarce.
- Nie zmieniano semantyki serwerowego pagera ani nie kasowano historii.
