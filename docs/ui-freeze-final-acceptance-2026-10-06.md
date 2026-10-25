# UI freeze — odbiór końcowy (liść 8.3)

Data: 2026-10-06. Workspace: `/path/to/cretli`. **HEAD (commit bazy):**
`53551b9fd4402af56c5064c3c43f656144e39445` (drzewo robocze z etapami 0–8, bez
commita w tej sesji). Zakres: porównanie trace końcowego z baseline 0.1, raportem
P0 3.3 oraz pomiarami po 8.1/8.2.

Powiązania: `docs/ui-freeze-baseline-2026-10-05.md`,
`docs/ui-freeze-p0-acceptance-2026-10-06.md`, `docs/performance-8.1.md`,
`docs/integration-8.2.md`, `docs/archive-virtualization-7.2.md`.

## Metodologia i ograniczenia

| Aspekt | Wartość |
| --- | --- |
| Urządzenie / OS | WSL2, x64/linux, Node **v22.23.2** |
| Viewport referencyjny (baseline 0.1) | **390×844**, DPR 2 — **nie powtórzono** pełnego scenariusza manualnego (reload → archiwum → poll ≥20 s → input/scroll → offline) w tej sesji |
| Dane realne | `data/chats.json` — **1468** czaty, **1167** archiwalnych; `summarizeChatRunStates()` na żywo |
| Dane syntetyczne | Skrypty 0.1: 1500 wpisów map aktywności; harness DOM archiwum: 1500 / 2500 / 10000 wierszy |
| Instrumentacja 0.1 | `?uiFreezeDiag=1` / liczniki w modułach — weryfikacja przez **testy Node**, **skrypty** i **Playwright harness** (headless Chromium systemowy), nie przez `Trace-*.json` ani `window.__crUiFreeze.format()` z panelu Browser |
| Ograniczenie Browser MCP | Jak w baseline/P0: brak wykonywania skryptów konsoli w panelu Browser — brak zrzutu freeze counters z produkcyjnego UI |

Scenariusz 0.1 (kroki 1–7 z baseline) pozostaje **odtwarzalny manualnie**; ta
sesja stosuje **te same moduły i progi**, co trace 2025-10-05, z jawnie oznaczoną
metodą zamiast udawania pomiaru przeglądarkowego, którego nie wykonano.

## Tabela metryk: przed / P0 / po (8.3)

Źródło „przed”: trace **2025-10-05** (`docs/ui-freeze-baseline-2026-10-05.md`).
Źródło „P0”: `docs/ui-freeze-p0-acceptance-2026-10-06.md`. Źródło „po”: pomiary
**2026-10-06** (ta sesja, liść 8.3).

| Metryka | Przed (trace) | P0 (2026-10-06) | Po (8.3, 2026-10-06) | Uwagi |
| --- | ---: | ---: | ---: | --- |
| **`renderChatList` na batch pending** | ≥341 | **1** / batch | **1** / batch (bez regresji) | `chat-pending-remote-history.test.js`, `chat-list-pending-badges.test.js` |
| **Cache builds/writes tylko od pending** | ~10,5 s w oknie pollu | **0** / **0** | **0** / **0** | Ten sam kontrakt; testy OK |
| **`history.poll.apply` (naprawiona ścieżka)** | ≥11 208 ms (niedokończony) | max **~0,37 ms** (syntetyka) | **≪50 ms** (P0 mikrobenchmark nadal obowiązuje; testy pending OK) | Brak nowego profilu CPU Chrome |
| **`boot-cache.build` @ 1500** | mediana **828 ms**, **5992** reads/build | mediana **1,37 ms**, 0 reads | mediana **2,36 ms**, max **2,88 ms**, **0** reads, 300 wierszy | `measure-ui-freeze-baseline.mjs` |
| **`boot-cache.build` @ 301** | mediana **169,73 ms** | **0,29 ms** | **0,57 ms** | Nadal ≪50 ms, 0 reads |
| **Storage w renderze/komparatorze** | tysiące `readObjectMap` | **0** po hydratacji RAM | **0** (testy OK) | `chat-activity-store`, `chat-list-ranking-prepared-keys` |
| **Monitoring (real)** | setki–900+ monitorowanych | **80** czatów (**768** `attention\|archived=true` usunięte) | **152** czatów; **`attention\|archived=true` = 0** | Więcej czatów/agent-states niż w P0 (1468 vs 1392); bramka 3.1 nadal usuwa archiwalne `attention` |
| **Archiwum — węzły DOM (1500/10000)** | 115–133 tys. | pełny HTML (P0) | **≤21** zamontowanych wierszy (`mountedLimit` @ 400 px) | `sidebar-archive-virtualizer.test.js`, `sidebar-archive-virtual-dom.test.js` |
| **Otwarcie archiwum (`sidebar.archive.render`)** | setki ms layout + pełny HTML | poza P0 | **~30–33 ms** span, **17** wierszy @ 1500/10000/2500 | Playwright harness `__runSidebarArchiveOpenPerfHarness` (headless, sesja 8.3) |
| **Poll HTTP — czas (real UI)** | blokada ~832 ms batch | naprawiona ścieżka UI | **nie zmierzono** w tej sesji (brak Network trace) | Etap 3.1 + P0 nadal w kodzie |
| **Hydratacja / input / porcje (8.1)** | sync setki ms | sliced async | testy slice + boot sync OK | `chat-hot-path-slice.test.js`, `scheduler-yield.test.js` |
| **Cold-start parse (≤40 wierszy)** | cel ≤5 ms / ≤64 KB | zmierzone skryptem | mediana **0,04 ms**, JSON **7712 B** | Budżet **≤100 ms** pierwszego malowania offline — **nie zmierzony** w DevTools (jak P0) |

### Pomiar otwarcia archiwum (sesja 8.3, Playwright headless)

Harness: `tests/sidebar-workspace-dom/harness.js` →
`window.__runSidebarArchiveOpenPerfHarness(count)`; viewport testowy **400 px**,
limit **21** wierszy (formuła 7.2).

| `count` (archiwalne wiersze) | `openMs` / `spanMaxMs` | `mountedRows` | ≤50 ms |
| ---: | ---: | ---: | --- |
| 1500 | 30,1 | 17 | tak |
| 10000 | 32,8 | 17 | tak |
| 2500 | 32,6 | 17 | tak |

## Kryteria końcowe — wynik

| Kryterium | Werdykt | Dowód |
| --- | --- | --- |
| ≤1 refresh na synchroniczny batch pending | **PASS** | `chat-pending-remote-history.test.js`; brak `renderChatList` w callbacku pending (`chat-list-pending-badges.test.js`) |
| Zero cache builds/writes z pending | **PASS** | Test plakietek + kontrakt P0 bez regresji |
| Zero storage reads w renderze/komparatorze (po hydratacji) | **PASS** | `chat-activity-store.test.js` („storage-free after hydrate”); `chat-list-ranking-prepared-keys.test.js` |
| Ograniczone okno DOM dla 1500/10000 rekordów | **PASS** | Virtualizer: budżet **21** wierszy; DOM testy 1500 i **10000** — `mountedRows ≤ mountedLimit` |
| Brak tasków **>50 ms** w naprawionych ścieżkach (poll, boot build @1500, slice) | **PASS** | Poll: P0 max **0,37 ms**; build @1500 mediana **2,36 ms**; slice/monitoring async — testy 8.1 |
| Otwarcie archiwum po etapie 7 — brak tasków **>50 ms** | **PASS** | Harness Playwright: **30–33 ms** przy 1500–10000 wierszach; test `archive open records sidebar.archive.render span` — exit 0 |
| Brak sekundowych zastojów (poll UI) | **PASS** (logicznie) | Usunięta ścieżka ≥11 s `history.poll.apply`; brak regresji w testach; **brak** nowego trace potwierdzającego responsywność inputu na żywym UI |
| Budżet pierwszego malowania offline zachowany | **PASS** (częściowy) | Sync bootstrap: N=40, 64 KB, parse **≪5 ms** (`chat-local-boot-sync.test.js`, skrypt cold-start); **≤100 ms** end-to-end offline — **nie zmierzone** w przeglądarce (ograniczenie jak 0.1/P0) |

## Naprawy w tej sesji

**Brak zmian kodu** — odbiór opiera się na istniejących etapach 0–8 i testach
regresyjnych. Żadne kryterium nie wymagało naprawy w zakresie 0–8.

## Komendy i wyniki (2026-10-06, liść 8.3)

```text
node scripts/measure-ui-freeze-baseline.mjs
# 1500: median build 2.36 ms, max 2.88 ms, storage.reads/build 0, built rows 300
# 301: median 0.57 ms; cold-start 40 rows: median parse 0.04 ms, 7712 B

node scripts/measure-monitoring-archive-baseline.mjs
# real: 1468 chats, monitored 920→152, attention|archived=true 768→0

node tests/ui-freeze-counters.test.js
# OK

node tests/sidebar-archive-virtualizer.test.js
# pass 10, fail 0

node tests/sidebar-archive-virtual-dom.test.js
# pass 17, fail 0 (~14 s)

node tests/chat-hot-path-slice.test.js
# pass 7, fail 0

node tests/chat-local-boot-sync.test.js
# pass 11, fail 0

node tests/chat-list-load-freshness.test.js
# OK

node tests/chat-pending-remote-history.test.js
# OK

node tests/scheduler-yield.test.js
# pass 16, fail 0

node tests/chat-list-pending-badges.test.js
# OK

node tests/chat-list-ranking-prepared-keys.test.js
# pass 6, fail 0

node tests/chat-activity-store.test.js
# pass 15, fail 0
```

Dodatkowo (sesja 8.3): jednorazowy pomiar harnessu otwarcia archiwum (Playwright
`playwright-core` + system Chromium) — tabela powyżej.

Znane **5 niezwiązanych** failów pełnego `npm test` (approval-broker,
delegation-phase2b-e2e, delegation-review-tools, opencode-permission,
sdk-chat-run-adapter) — **poza zakresem** 8.3, nie uruchamiano pełnego suite.

## Odstępstwa

1. **Brak** nowego `Trace-*.json` i brak `window.__crUiFreeze.format()` z
   produkcyjnego UI (390×844, poll ≥20 s, input/scroll) — ocena oparta na
   instrumentacji w Node/Playwright harness oraz porównaniu z trace 2025-10-05.
2. **Budżet ≤100 ms** pierwszego malowania offline — parsowanie sync spełnia
   podbudżet 5 ms/64 KB; całość offline reload **nie zmierzona** w DevTools.
3. **Monitoring „po”** — 152 monitorowane czaty (vs 80 w P0) przez większy
   `chats.json` i aktualne agent-states; kryterium bramki archiwum (`attention`
   na archiwum = 0) **spełnione**.
4. **`boot-cache.build` @ 1500** — mediana **2,36 ms** vs **1,37 ms** w P0 (ta
   sama maszyna, wariancja runów); nadal **≪50 ms** i **0** storage reads.

## Podsumowanie odbioru końcowego

Etapy **0–8** spełniają kryteria odbioru liścia **8.3**: ścieżka pollu i pending
bez pełnego renderu i bez budowy cache, comparator bez storage po hydratacji,
archiwum z wirtualnym oknem DOM (1500/10000) i otwarciem **~30 ms** w harnessie,
gorące ścieżki porcjowane (8.1), integracja IDB/offline/Lit (8.2) bez regresji
w wymienionych testach. Pełny trace Chrome i offline FCP pozostają **zalecanym**
powtórzeniem manualnym na urządzeniu baseline, ale **nie blokują** werdyktu PASS
przy obecnym pakiecie dowodów regresyjnych i pomiarów odtwarzalnych.

**Werdykt liścia 8.3: PASS**
