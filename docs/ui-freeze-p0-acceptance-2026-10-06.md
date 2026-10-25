# UI freeze — odbiór P0 przed migracją P1 (liść 3.3)

Data: 2026-10-06. Workspace: `/path/to/cretli`. **HEAD (drzewo robocze,
bez commita):** `53551b9fd4402af56c5064c3c43f656144e39445`. Zakres: etapy 0–3
(instrumentacja, pending/patch, RAM activity + persistence queue, bramka
monitoringu archiwum). Etapy 4–8 poza tym odbiorem.

Powiązania: `docs/ui-freeze-baseline-2026-10-05.md`, `docs/monitoring-archive-3.1.md`.

## Metodologia pomiaru

| Aspekt | Wartość |
| --- | --- |
| Urządzenie / OS | WSL2, x64/linux, Node **v22.23.2** |
| Dane realne | `data/chats.json` — **1392** czaty, **1167** archiwalnych; mapa runów z `summarizeChatRunStates()` |
| Dane syntetyczne | Skrypty: 1500 czatów / 1500 wpisów map aktywności (jak 0.1) |
| Scenariusz 0.1 (przeglądarka) | **Nie powtórzony w tej sesji** z pełnym `Trace-*.json` ani `window.__crUiFreeze.format()` — panel Browser nie wykonuje skryptów konsoli (ograniczenie jak w baseline 2026-10-06, próba 3). Viewport referencyjny z baseline: **390×844**, DPR 2 |
| Odtwarzalność | Skrypty Node + testy integracyjne + mikrobenchmark ścieżki pollu (jawnie oznaczone jako **syntetyczne**, bez profilu CPU przeglądarki) |

## Tabela przed / po

Źródło „przed”: trace i audyt **2026-10-05** (`docs/ui-freeze-baseline-2026-10-05.md`).
Źródło „po”: pomiary **2026-10-06** (ta sesja).

| Metryka | Przed (trace 2025-10-05) | Po (P0, 2026-10-06) | Uwagi |
| --- | ---: | ---: | --- |
| **Poll — `renderChatList` na batch pending** | ≥341 | **1** refresh / batch (`ui.pendingRefreshes`) | Test + mikrobenchmark; wiring `chat.js` → `applyChatListPendingBadges` |
| **Poll — cache builds/writes tylko od pending** | ~10,5 s `writeChatLocalBootCache` w oknie pollu | **0** builds / **0** writes przy 300 flipach | Mikrobenchmark + test plakietek |
| **Poll — task `history.poll.apply`** | ≥11 208 ms (niedokończony) | **≤0,37 ms** (1500 wierszy modalu, 300 net changes) | Syntetyczny DOM; cel ≤50 ms |
| **Cache — `boot-cache.build` @ 1500 czatów** | mediana **828 ms**, **5992** `storage.reads`/build | mediana **1,37 ms**, **0** reads/build | `measure-ui-freeze-baseline.mjs` |
| **Cache — `boot-cache.build` @ 301** | mediana **169,73 ms**, 1196 reads | mediana **0,29 ms**, 0 reads | Ten sam skrypt |
| **Comparator / render — odczyty storage** | tysiące `readObjectMap` na sort | **0** po jednorazowej hydratacji RAM | `chat-list-ranking-prepared-keys.test.js`, `chat-activity-store.test.js` |
| **Monitoring — monitorowane czaty (real)** | **838** (kandydaci **846**+) | **80** (**857 → 89** reason matches) | `measure-monitoring-archive-baseline.mjs`; **768** archiwalnych `attention` usunięte |
| **Monitoring — `attention\|archived=true`** | 768 | **0** | Bramka 3.1 |
| **Archiwum — pełny render (P1+)** | 115–133 tys. węzłów DOM; `onSidebarLayout` ~842 ms inclusive | **Bez zmiany budżetu P0** — nadal pełny HTML przy otwartej sekcji | Span `sidebar.archive.render`; ~942 wiersze w próbie Browser (baseline) |

## Kryteria P0 — wynik

| Kryterium | Werdykt | Dowód |
| --- | --- | --- |
| ≤1 refresh na synchroniczny batch pending | **PASS** | `chat-pending-remote-history.test.js` (300 zmian → 1 publish); mikrobenchmark `publishCount: 1` |
| Zero cache builds/writes pochodzących **wyłącznie** z pending | **PASS** | `chat-list-pending-badges.test.js` (brak `renderChatList` w callbacku); `cache.builds/writes: 0` przy batchu pending |
| Zero storage reads w renderze/komparatorze (po hydratacji) | **PASS** | `boot-cache build has zero storage reads after activity hydrate`; `render/boot-cache comparator is storage-free after the one-time hydrate` |
| Żaden task naprawionej ścieżki pollu **>50 ms** | **PASS** | `history.poll.apply` max **~0,37 ms** (300 badge’ów, 1500 wierszy); instrumentowany span zgodny |

Cel **≤50 ms dla otwarcia całego archiwum** — **poza zakresem P0** (etap 7). Poniżej koszt znany z diagnozy.

## Wyodrębnienie: ścieżka pollu vs pełny render archiwum

**Naprawiona ścieżka pollu (P0, budżet ≤50 ms):**

1. HTTP poll ustawia flagi przez `setChatPendingRemoteHistoryFlag` w batchu
   (`beginPendingRemoteHistoryBatch` / `endPendingRemoteHistoryBatch`) —
   `app_front/features/chat/chatPendingRemoteHistoryFlag.js`.
2. Jeden publish → span `history.poll.apply` → callback w `app_front/chat.js`
   (~3061–3066) → `chatView.applyChatListPendingBadges` →
   `applyChatListPendingBadgePatch` (`app_front/features/chat/chatListPendingBadges.js`) —
   jeden pass `querySelectorAll`, dotyk tylko zmienionych wierszy.

**Nadal pełny render (świadomie poza P0):**

- Otwarcie sekcji archiwum: `renderArchiveSection` + span `sidebar.archive.render`
  (`app_front/features/sidebar/sidebarView.js` ~1068–1086) — serializacja HTML dla
  wszystkich wierszy drzewa archiwum.
- `collectRenderableChatIds` (~1455) — wszystkie archiwalne id gdy sekcja otwarta.
- Layout sidebara (`sidebar.layout.apply`, `forceRerender`) — historycznie setki ms
  przy setkach wierszy; **nie** liczone do budżetu pollu P0.

Po 3.1 poll HTTP **nie** obejmuje zaległych archiwalnych `waiting`/`attention`
(`selectHistoryHttpChatIds` + bramka), ale **DOM archiwum** nadal mountuje pełną listę
— to materiał na P1 (wirtualizacja / incremental DOM).

## Koszt pełnego renderu archiwum (znany, poza P0)

- Trace **2025-10-05**: **115–133 tys.** węzłów DOM po otwarciu archiwum;
  `onSidebarLayout` **842 ms** inclusive.
- Próba Browser **2026-10-06** (baseline doc): **942** wiersze archiwum;
  porcja `history-batch` ~**832 ms** wall time (wiele żądań w tej samej ms) —
  wskazuje blokadę głównego wątku przy dużym zbiorze, **nie** na ścieżce
  `history.poll.apply` po P0.
- Instrumentacja: span `sidebar.archive.render` (`uiFreezeCounters.js`,
  `INSTRUMENTED_SPAN_NAMES`) — do pomiaru w przeglądarce przy `?uiFreezeDiag=1`.

## Pliki kluczowe (implementacja P0)

| Obszar | Plik | Linie (orientacyjnie) |
| --- | --- | --- |
| Batch pending + span pollu | `app_front/features/chat/chatPendingRemoteHistoryFlag.js` | 107–119, 203–216 |
| Brak full render na pending | `app_front/chat.js` | 3061–3066 |
| Patch plakietek | `app_front/features/chat/chatListPendingBadges.js` | 64–80 |
| RAM activity (bez storage w comparatorze) | `app_front/features/chat/chatActivityStore.js` | 1–25 |
| Prepared ranking | `app_front/features/chat/chatListSort.js` | 26+ |
| Boot cache + span build | `app_front/features/chat/chatLocalBootCache.js` | 364+ |
| Kolejka utrwalenia odłączona od renderu | `app_front/features/chat/chatPersistenceQueue.js` | (testy 2.3) |
| Bramka monitoringu archiwum | `app_front/features/chat/chatBackgroundPolicy.js` | (3.1) |
| Render archiwum (koszt P1) | `app_front/features/sidebar/sidebarView.js` | 1068–1086, ~1455 |

## Komendy i wyniki (2026-10-06)

```text
node --test tests/ui-freeze-counters.test.js \
  tests/chat-pending-remote-history.test.js \
  tests/chat-local-boot-cache.test.js \
  tests/chat-list-sort.test.js \
  tests/monitoring-archive-qualification.test.js
# pass 20, fail 0

node --test tests/chat-list-pending-badges.test.js
# pass 1, fail 0

node --test tests/chat-list-ranking-prepared-keys.test.js \
  tests/chat-activity-store.test.js \
  tests/chat-persistence-queue.test.js
# pass 27, fail 0

node scripts/measure-ui-freeze-baseline.mjs
# 1500 chats: median build 1.37 ms, storage.reads/build 0

node scripts/measure-monitoring-archive-baseline.mjs
# real: monitored 848 → 80; attention|archived=true 768 → 0
```

Mikrobenchmark ścieżki pollu (Node, syntetyczny modal 1500 wierszy, 300 net
pending): mediana **0,16 ms**, max **0,37 ms**; `publishCount: 1`, `cache.builds: 0`.

## Odstępstwa i ograniczenia

- Brak nowego nagrania Performance (`Trace-*.json`) i brak zrzutu
  `window.__crUiFreeze.format()` z żywej sesji — ocena P0 opiera się na
  **testach regresyjnych**, skryptach syntetycznych i porównaniu z trace
  **2025-10-05** oraz próbą Browser opisaną w baseline.
- Liczby Node **nie** zastępują profilu CPU w Chromium; potwierdzają jednak te same
  instrumentowane moduły co UI z `?uiFreezeDiag=1`.
- Budżet pierwszego malowania offline (≤100 ms) z 0.1 — **nadal nie zmierzony**
  w tej sesji (wymaga DevTools offline reload).
- **Nie wprowadzono poprawek kodu** w tej sesji — kryteria P0 spełnione przez
  wcześniejsze etapy 0–3; brak regresji w testach.

## Podsumowanie odbioru

P0 uznaje się za **spełnione**: poll nie odpala pełnego `renderChatList`, nie
buduje boot cache z pending, comparator/render nie czyta storage po hydratacji
RAM, taski ścieżki pollu są **≪50 ms** na syntetyce. Pełny render archiwum i
layout sidebara pozostają osobnym, znanym kosztem do etapów P1/7.
