# UI freeze — gorące ścieżki i porcjowanie (liść 8.1)

Data: 2026-10-06. Workspace: `/path/to/cretli`. Helper 4.1:
`app_front/lib/schedulerYield.js` (`forEachInTimeSlices`, `DEFAULT_SLICE_BUDGET_MS`
≈ 8 ms, `applyIfFresh`, `scheduleDomWrite`). Liście 5.3/7.1 (boot/archive hydrate)
bez zmiany kontraktu — ten liść dotyczy **pozostałych** selekcji i reconcile.

## Pomiar (przed / po, Node v22.23.2)

Źródło „przed”: trace + baseline 2026-10-05 (`docs/ui-freeze-baseline-2026-10-05.md`) —
blokady setki ms na `boot-cache.build` @ 1500 (storage w komparatorze), pełny
`serverChats.map` przy `GET /api/chats`, synchroniczny scan `selectMonitoredChatIds`
@ ~1400 wierszy, synchroniczna projekcja IDB archiwum.

Źródło „po”: `node scripts/measure-ui-freeze-baseline.mjs` + testy regresji 8.1
(`tests/chat-hot-path-slice.test.js`) — **syntetyczne**, bez long-task CPU w
przeglądarce w tej sesji.

| Ścieżka | Przed (diagnoza) | Po (8.1) | Uwagi |
| --- | ---: | ---: | --- |
| `boot-cache.build` @ 1500 | mediana ~828 ms, tysiące storage reads | mediana **1,34 ms**, 0 reads, 300 wierszy | RAM ranking (P0); **>300** źródeł: `buildChatLocalBootCacheDocAsync` + `writeChatLocalBootCacheToAdapterAsync` w kolejce |
| `GET /api/chats` reconcile | jeden sync `map` | `reconcileServerChatsInTimeSlices` od **64** wierszy; token listy (rewizja po bumpie odpowiedzi) sprawdzany **po** yield |
| Poll: `selectMonitoredChatIds` | sync loop | `selectMonitoredChatIdsAsync` od **128** wierszy |
| Archiwum IDB → wiersze | sync `.map` | `projectMetadataRecordsToRows` (time slices) |
| Hydratacja archiwum → runtime | slice bez `applyIfFresh` | `applyIfFresh` po yield (jak 5.3) |
| Repaint listy po reconcile / async boot | sync `renderChatList` | **`scheduleDomWrite`** (mały zapis DOM); fallback sync gdy brak rAF |

Budżet slice: domyślnie `DEFAULT_SLICE_BUDGET_MS = 8`. Opcjonalna kalibracja:
`calibrateSliceBudgetMsFromSample` + `measureSyncChunkDurationMs` (400 próbek noop) —
przy bardzo taniej próbce zostaje 8 ms; przy drogiej per-item obniża budżet w zakresie 4–16 ms.

**Ograniczenia pomiaru:** skrypty i testy Node (`measure-ui-freeze-baseline.mjs`,
`chat-hot-path-slice.test.js`) mierzą sync CPU i porównują ścieżki sync vs async z
natychmiastowym yieldem — nie zastępują long-task trace w Chrome (throttling rAF, sieć, layout).

## Dostrojone pliki

| Plik | Zmiana |
| --- | --- |
| `app_front/lib/schedulerYield.js` | kalibracja próbki, bez zmiany domyślnego 8 ms |
| `app_front/features/chat/chatLocalBootCache.js` | `buildChatLocalBootCacheDocAsync`, `writeChatLocalBootCacheToAdapterAsync` |
| `app_front/features/chat/chatPersistenceQueue.js` | flush boot cache przez async build |
| `app_front/features/chat/chatListServerReconcile.js` | **nowy** — merge wiersza + sliced reconcile |
| `app_front/features/chat/chatController.js` | async reconcile, rAF repaint, token po yield |
| `app_front/features/chat/chatBackgroundPolicy.js` | `selectMonitoredChatIdsAsync`, wspólny `considerChatForMonitoring` |
| `app_front/features/chat/chatHistorySyncPoll.js` | await async monitoring selection |
| `app_front/features/chat/chatArchiveDataSource.js` | `projectMetadataRecordsToRows`, `applyIfFresh` w archive hydrate |
| `app_front/features/chat/chatArchiveCatalog.js` | sliced IDB projection |

Progi slice: `CHAT_BOOT_CACHE_BUILD_SLICE_THRESHOLD` = 300,
`CHAT_LIST_SERVER_RECONCILE_SLICE_THRESHOLD` = 64,
`MONITORED_CHAT_IDS_SLICE_THRESHOLD` = 128.

## Worker

**Nie dodano.** Po P0/P1 dominujące koszty to I/O sieci, sort rankingowy (już RAM O(n)
przy budowie cache) i pojedyncze repainty DOM — w Node wszystkie mierzone build/reconcile
< **50 ms** na całą operację; porcjowanie macrotask/`scheduler.yield` wystarcza.
Worker rozważany dopiero gdy trace przeglądarki pokaże sync CPU >50 ms **mimo** slice
(np. ciężki sort na >10k wierszy) — nie wystąpiło w baseline 8.1.

## Weryfikacja (komendy)

```bash
node tests/scheduler-yield.test.js
node tests/sidebar-archive-virtualizer.test.js
node tests/chat-archive-data-source.test.js
node tests/chat-local-boot-sync.test.js
node tests/ui-freeze-counters.test.js
node tests/chat-hot-path-slice.test.js
node scripts/measure-ui-freeze-baseline.mjs
```

Wynik sesji implementacji 8.1: **wszystkie powyższe OK** (16 + 10 + OK + 10 + OK + 5 testów).

## Odstępstwa

- Brak powtórzenia pełnego trace Chrome (390×844) w tej sesji — jak w odbiorze P0 3.3.
- Sort `rankedRest` w `selectChatsForBootCache` pozostaje synchroniczny na ≤~1200 wierszy
  po sanitize; przy obecnych pomiarach <50 ms — bez workera.
- `scripts/review-verify.js`: rejestracja nowych testów — zakres liścia 8.2.

## Anulowanie / fallback

- Reconcile HTTP: token apply oparty o rewizję **po** `bumpListRevision()` na odpowiedzi;
  `isChatListLoadApplyTokenFresh` po każdej porcji — późny wynik **nie** nadpisuje listy
  (`cancelled: true`, wcześniejszy return w `loadChatsFromServer`).
- Boot/archive hydrate: istniejące guardy 5.3/7.1 + `applyIfFresh` w archive hydrate.
- Kolejka persist: epoch/session z 2.3 bez zmiany semantyki invalidation.
