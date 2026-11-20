# UI freeze — odbiór z rzeczywistego trace Chromium (liść 5.2)

Data: 2026-10-06. Workspace: `/path/to/cretli`. Rodzic todo:
`252dd2c9-280c-4638-bb9b-a9c67ae04154` (etap 5), root:
`33e307a2-741d-4ec1-94d4-2aa0a94616bb`. Liść: **5.2** (`6f0a0a39-…`).

Zakres: powtórzyć trace na żywym UI (viewport **1920×525**) i sprawdzić scenariusz
mobilny oraz — dodatkowo — archiwum i bootstrap offline; porównać przed/po;
zapisać dowody i ograniczenia. **Nie zmieniano kodu ani trwałych danych** tej
sesji.

Powiązania: `docs/ui-freeze-trace-2026-10-06.md` (diagnoza/baseline),
`docs/ui-freeze-contracts-2026-10-06.md` (kontrakty i budżety),
`docs/ui-freeze-baseline-2026-10-06.md`, `docs/ui-freeze-integration-review-2026-10-06.md`.

## Werdykt liścia 5.2

**ODBIÓR POTWIERDZONY (PASS) po poprawce tool output (2026-10-06 wieczór).**
Pierwszy trace (przed fixem) wykazał jedną lukę: **118,9 ms** apply dla ~1 MB
`tool_call` stdout. Po limicie podglądu (wzorzec etapu 3) powtórzono **realny**
trace CDP (`Trace-after-fix-desktop.json`, ten sam viewport **1920×525**).

- ✅ sidebar open/pin: bez regresji (faza C w obu trace),
- ✅ input latency: bez regresji (max **48 ms**),
- ✅ mounted DOM: **80 kart** (cap), nodes ~45 tys. po długiej turze,
- ✅ **długa tura / ~1 MB tool output (faza G)**: max klaster
  `replay_clusters` **`applyHistoryRecord` = 30,2 ms** (poprzednio **118,9 ms**);
  typowe klastry **8,7–14,3 ms**; brak apply >50 ms w naprawianej ścieżce,
- ✅ pełny stdout dostępny na żądanie (store + expand/copy jak raport delegacji),
- ⚠️ boot SPA (`EvaluateScript` ~168 ms max long task) — poza zakresem napraw 0–5,
- ⚠️ archiwum / offline — bez zmian względem pierwszego trace (patrz niżej),
- ⚠️ `pageerror … reading 'catch'` — **nadal** przy boot/nawigacji (3× w sidecarze
  po fixie); nie w ścieżce replay; brak jednoznacznego mapowania na nowy kod
  (dodano tylko `.catch` na łańcuchu `ensurePrime()` w `chat.js`).

### Porównanie fazy G — przed / po fixie (realny trace)

| Metryka | Trace „po” (przed fixem tool output) | Trace po fixie |
| --- | ---: | ---: |
| Max klaster `replay_clusters` (apply) | **118,9 ms** | **30,2 ms** |
| Klaster apply w oknie fazy G (~28–36 s) | **118,9 ms** | **14,3 ms** |
| Karty po G | 80 | 80 |
| Nodes po G | ~20,3 tys. | ~45,2 tys. (bez regresji względem soft cap) |

**Harness (Node + Chromium):** `tests/ui-freeze-tool-call-output-preview.test.js`
— apply ~1 MiB stdout **≤50 ms**, DOM **<80** węzłów, pełna treść w store po
`preserveWhitespace: true` dla outputu narzędzia.

## Metoda

| Aspekt | Wartość |
| --- | --- |
| Przeglądarka | systemowy Chromium `/usr/bin/chromium`, Playwright `playwright-core` 1.63.0, headless, `--no-sandbox --disable-dev-shm-usage --disable-gpu --ignore-certificate-errors` |
| Aplikacja | żywy serwer Cretli na `https://127.0.0.1:3011` (working tree z etapami 0–5.1; webpack dev bundle) |
| Uwierzytelnienie | istniejąca sesja z `data/sessions.json` (`cr_session`), podpisana lokalnie; **żadnych sekretów w artefaktach**, żadnych nowych sesji na dysku |
| Viewport | desktop **1920×525** (jak baseline), mobile **390×844 DPR 2** |
| Trace | CDP `Tracing.start` (`transferMode: ReturnAsStream`), kategorie: `devtools.timeline`, `disabled-by-default-devtools.timeline{,.frame,.stack,.inputs}`, `devtools.timeline.frame`, `blink.user_timing`, `latencyInfo`, `v8`, `disabled-by-default-v8.cpu_profiler`, `benchmark` |
| Fazy | `performance.mark()` (`A`–`H`) w trace; sidecar JSON zbiera `Performance.getMetrics` (Nodes, Documents, JSEventListeners, LayoutObjects, heap), liczby kart i snapshot `window.__crUiFreeze` przy granicach faz |
| Analiza | własny analizator strumieniowy `.tmp/ui-freeze-52/analyze_trace.py` (niskie zużycie RAM); ten sam pipeline użyty do ponownego przeliczenia baseline — liczby baseline odtworzone **co do wartości** z `docs/ui-freeze-trace-2026-10-06.md` (patrz niżej) |
| Atrybucja faz | `.tmp/ui-freeze-52/extract_phases.py` (long taski + dzieci + marki), klastry wywołań z profilu CPU w analizatorze |

### Walidacja metody (baseline przeliczony tym samym kodem)

| Metryka | Dokument baseline | Analizator 5.2 |
| --- | ---: | ---: |
| Renderer main | PID 44408 / TID 66256 | PID 44408 / TID 66256 (`CrRendererMain`) |
| Czas | 35,79 s | 35,791 s |
| Long tasks >50 ms | 114 | 114 |
| Longest task | 3361,5 ms | 3361,514 ms |
| Max interaction latency | 2448,8 ms | 2448,764 ms |
| UpdateLayoutTree | 10 658 ms | 10 658,0 ms |
| Commit | 7347 ms | 7346,882 ms |
| Nodes max | 509 961 | 509 961 |
| Listeners max | 15 502 | 15 502 |
| `captureInsertScroll` inclusive | 7395,0 ms | 7394,956 ms |

To potwierdza, że „przed” i „po” policzono **tym samym** kodem i definicjami.

## Artefakty

Katalog roboczy (gitignored): `/path/to/cretli/.tmp/ui-freeze-52/`.
Trwała kopia **małych** artefaktów (wyniki analiz, sidecary, skrypty) jest w repo:
`docs/ui-freeze-acceptance-2026-10-06-artifacts/` (244 KB). Surowe trace'y
(150 MB) pozostają tylko w `.tmp` (gitignored) — nie commituję ich.

| Plik | Rozmiar | Opis |
| --- | ---: | --- |
| `traces/Trace-after-desktop.json` | 74 933 633 B | realny trace desktop: A–H (40,0 s) |
| `traces/Trace-after-mobile.json` | 71 287 176 B | realny trace mobile 390×844 (40,2 s) |
| `traces/Trace-after-offline.json` | 2 780 197 B | bootstrap offline po SW (9,5 s) |
| `traces/Trace-after-archive.json` | 7 132 054 B | otwarcie sekcji archiwum (5,5 s) |
| `desktop-sidecar.json`, `mobile-sidecar.json`, `offline-sidecar.json`, `archive-sidecar.json` | 2,5–13 KB | marki, próbki metryk DOM, błędy strony, longtaski `PerformanceObserver` |
| `baseline-analysis.json`, `desktop-after-analysis.json`, `mobile-after-analysis.json`, `offline-after-analysis.json`, `archive-after-analysis.json` | 9–44 KB | wynik analizatora |
| `desktop-phases.json`, `mobile-phases.json`, `archive-phases.json` | — | long taski z dziećmi + statystyki per faza |
| `analyze_trace.py`, `extract_phases.py`, `live-trace.mjs` | — | skrypty pomiarowe (odtwarzalne) |

Skrypty sterujące: `.tmp/ui-freeze-52/live-trace.mjs` (scenariusze `desktop`,
`mobile`, `offline`, `archive`). Baseline trace pozostaje w
`/tmp/tracew/Trace-20261006T151320.json/` (tylko odczyt).

## Porównanie przed / po (desktop 1920×525)

„Przed” = trace z 2026-10-06 15:13 (`docs/ui-freeze-trace-2026-10-06.md`,
przeliczony analizatorem 5.2). „Po” = `Trace-after-desktop.json` (40,0 s, ten sam
viewport, ten sam ciężki czat `f9f6294e…` + raport 800 KB; dodatkowo długi turn
i archiwum).

| Metryka | Przed | Po | Zmiana |
| --- | ---: | ---: | --- |
| Czas nagrania | 35,79 s | 40,04 s | inne kroki (4 nawigacje) |
| Long tasks >50 ms | **114** | **7** | −94% |
| Suma long tasków | **25 065 ms** | **778 ms** | −96,9% |
| Suma części >50 ms | 19 365 ms | 428 ms | −97,8% |
| Najdłuższe zadanie | **3361,5 ms** | **143,5 ms** | −95,7% |
| Max interaction latency | **2448,8 ms** | **48 ms** | −98,0% |
| Max zwłoka przed handlerem | 1849,6 ms | 20 ms | −98,9% |
| `UpdateLayoutTree` | 10 658 ms / 2214 | 494 ms / 1915 | −95,4% |
| `Layout` | 3117,6 ms / 793 | 240 ms / 166 | −92,3% |
| `Commit` | 7346,9 ms / 322 | 148 ms / 1390 | −98,0% |
| `PrePaint` | 2247 ms / 664 | 138,6 ms / 1740 | −93,8% |
| Nodes pierwszy→ostatni | 33 093 → 509 961 | 4 → 19 955 (start trace przed nawigacją) | — |
| Nodes maksimum | **509 961** | **44 506** | −91,3% |
| Listeners maksimum | **15 502** | **3798** | −75,5% |
| Heap maksimum | 118,1 MB | 76,1 MB | −35,6% |
| `captureInsertScroll` (klastry) | do **624 ms**, łącznie 7395 ms | **brak klastrów (0 próbek)** | usunięte |
| `isScrollableNearBottom` | klastry ~24 ms | 1 próbka ≈ 0 ms | usunięte |
| `applyHistoryRecord` typowy klaster | 180–624 ms | **8,1–10,4 ms** | ~8 ms |
| `applyHistoryRecord` maks. klaster | 624 ms | **118,9 ms** → **30,2 ms** po fixie tool output | PASS |

Uwaga do `Commit`: w „po” jest go **więcej zdarzeń** (1390 vs 322), ale o dwa
rzędy tańszych — łączny czas spadł z 7347 ms do 148 ms.

## Scenariusze desktop — per faza (main thread)

Fazy z `performance.mark` (A–H). „Max zadanie” = najdłuższy `RunTask` w oknie.

| Faza | Okno [s] | Max zadanie | >50 ms | Komentarz |
| --- | --- | ---: | ---: | --- |
| A. ciężki czat local+HTTP + input w replayu | 0,003–9,101 | 137,9 ms | 2 | long taski to boot: `EvaluateScript` 137,8 ms + pierwsza klatka 57,3 ms; **żadnego >50 ms w replayu** |
| B. history scroll (góra/dół) | 9,102–12,114 | 7,0 ms | 0 | `captureInsertScroll` brak; karty 25→26 |
| C. sidebar open + pin | 12,115–15,152 | **26,2 ms** | 0 | ≤50 ms main thread ✅ |
| D. szybkie przełączenia A→B→A | 15,153–18,338 | 37,3 ms | 0 | `history.replay` span **88,5 ms**, 4 batche; brak `stale-complete` w próbkach |
| E. zmiana panelu chat↔terminal | 18,339–21,461 | 34,2 ms | 0 | `sidebar.layout.apply` 0,3 ms |
| F. raport 800 KB (delegacja/mailbox) | 21,462–28,233 | 126,7 ms | 2 | long taski to nawigacja (`EvaluateScript` 126,5 ms) + pierwsza klatka; karta raportu **33 karty, 17,9 tys. nodes** |
| G. długa tura (`b6c301d6…`) | 28,234–36,107 | **143,5 ms** | 3 | przed fixem: apply **118,9 ms**; **po fixie** (trace `Trace-after-fix-desktop.json`): apply **≤30,2 ms**, max faza G **168 ms** (boot `EvaluateScript`, nie apply) |
| H. archiwum | 36,108–39,441 | 21,1 ms | 0 | klik toggluje sekcję; 0 zamontowanych wierszy |

Long taski po (7) w rozbiciu: 3× `EvaluateScript` (boot SPA, 126–138 ms), 3×
pierwsza klatka po nawigacji (`ProxyMain::BeginMainFrame` + rAF, 57–101 ms), 1×
apply długiej tury (118,9 ms). **W ścieżkach naprawianych (replay, scroll,
sidebar, przełączenia, panel) nie ma zadań >50 ms** — poza apply długiej tury.

### Długa tura / ~1 MB tool output — naprawa (2026-10-06)

Przyczyna **118,9 ms**: `createToolBody` robiło `JSON.stringify` całego `result`
(~1 MB) zanim `stringifySnippet` obcięło do 4800 znaków. Fix:
`sdkToolCallOutputPreview.js` — ekstrakcja `stdout` bez pełnego stringify,
podgląd 16 KiB + expand/copy (store z etapu 3), `preserveWhitespace: true` dla
outputu narzędzia (delegacja nadal trimuje raporty).

Trace po fixie: max `replay_clusters` **30,2 ms**; faza G: klaster **14,3 ms** przy
~28–36 s.

## Scenariusz mobilny (390×844 DPR 2)

`Trace-after-mobile.json`, 40,2 s: ciężki czat → sidebar → panel → raport 800 KB.
Na mobile `#sidebar-pin-btn` i `.tab[data-panel]` nie są widoczne (pin jest
desktopowy, taby schowane w menu), więc te dwa kliknięcia odnotowano jako
nieudane i **nie są** dowodem. Zmierzone:

| Metryka | Wartość |
| --- | ---: |
| Long tasks >50 ms | **2** (oba `EvaluateScript` boot: 135,2 ms i 91,0 ms) |
| Max interaction latency / queue | 48 ms / 3 ms |
| Nodes maks. / ostatni | 37 462 / 17 816 |
| Listeners maks. | 4491 |
| Ciężki czat | 25 kart, 18,9 tys. nodes |
| Raport 800 KB | 33 karty, 17,8 tys. nodes |
| Long taski w replay/sidebar/panel | **0** |

## Dodatkowo: archiwum

`Trace-after-archive.json`. Nagłówek pokazuje `Archive 943`
(`data-sidebar-key=/path/to/projects/cretli.code-workspace`). Klik zmienia
`aria-expanded` i `cretli-sidebar-archive-open` z `null` na
`["/path/to/projects/cretli.code-workspace"]`, ale `.sidebar-archive-list`
ma **0 dzieci** i wysokość 0 (brak requestu po archiwalne czaty; `/api/chats`
zwraca wyłącznie nie-archiwalne). Span `sidebar.archive.render` = ~0 ms,
`sidebar.layout.skipped = 3`. Long taski: 97,8 ms `CpuProfiler::StartProfiling`
(artefakt startu tracingu), 54,9 ms pierwsza klatka, 73,5 ms obsługa kliknięcia
(`WidgetBaseInputHandler::OnHandleInputEvent`/`EventDispatch`).

Wniosek: **render wierszy archiwum nie jest pokryty tym realnym trace** (na żywo
montuje 0 wierszy). Pokrycie wierszy pozostaje harnessowe z etapu 7
(`__runSidebarArchiveOpenPerfHarness`, 1500/10000 wierszy, ~30–33 ms) — jawnie
oznaczone jako harness, nie trace.

## Dodatkowo: bootstrap offline

`Trace-after-offline.json`. Po rozgrzaniu online: SW `count=1`,
`controller=true`. Po `context.setOffline(true)` + przeładowaniu żądanego czatu:

| Metryka | Wartość |
| --- | ---: |
| URL / title | `…/chat?chat=f9f6294e…` / „Cretli – Terminal & Chat” |
| `#chat-panel`, `#app-sidebar` | obecne |
| first-paint / FCP | **168 ms** |
| zasoby z cache | 8 |
| karty czatu | **0** |
| nodes / listeners | 25 129 / 2141 |
| long taski | 2 (m.in. 110 ms `CpuProfiler::StartProfiling` — artefakt tracingu) |

Powłoka aplikacji wstaje z SW bardzo szybko (FCP 168 ms), ale **hydratacja
historii offline nie zachodzi** (`cards=0`, `bodyTextLen=125`). To nie potwierdza
funkcjonalnego bootu offline — traktuję jako pokrycie częściowe (tylko shell/FCP).

## Realny trace vs harness vs niezmierzone

| Obszar | Źródło | Status |
| --- | --- | --- |
| Ciężki czat local+HTTP, scroll, sidebar open/pin, szybkie przełączenia, panel, raport 800 KB, długa tura | **realny trace CDP** (desktop + mobile) | ✅ zmierzone |
| Input latency / kolejka, long taski, layout/commit/style, nodes, listeners, heap | **realny trace + `Performance.getMetrics`** | ✅ zmierzone |
| Geometria `captureInsertScroll` / `isScrollableNearBottom` | **realny trace (profil CPU + stacki layoutu)** | ✅ zmierzone (brak) |
| Aktywne replaje (`history.replay` span/batches) | snapshot `window.__crUiFreeze` w trace | ⚠️ częściowe (okno 1 s; brak `activeAsyncLoops`) |
| Archiwum — render wierszy | harness etapu 7 (poprzedni odbiór) | ⚠️ harness, nie trace |
| Offline — pełna hydratacja czatu | realny trace, ale `cards=0` | ⚠️ FCP zmierzone, hydratacja nie |
| Boot SPA `EvaluateScript` | realny trace | ✅ zmierzone (poza zakresem napraw 0–5) |

## Ograniczenia i obserwacje poboczne

1. **Sesja „po” ma 4 pełne nawigacje** (A, F, G + start), więc 3 z 7 long tasków
   to `EvaluateScript` bundle'a dev (~126–138 ms każdy). To koszt bootu, nie
   ścieżek naprawianych; w produkcji bundle jest inny — nie ekstrapolować.
2. **`PerformanceObserver('longtask')`** w sidecarze zgłasza 1–3 zadania (max
   143 ms), bo działa od `addInitScript`; miarodajne są `RunTask` z trace.
3. **Błąd strony** `TypeError: Cannot read properties of undefined (reading
   'catch')` — nadal w sidecarze po fixie (653 ms, ~22 s, ~29 s — boot/nawigacja).
   Nie reprodukuje się w testach replay (`chat-history-mounted-window`). Dodano
   `.catch` na `chatMetadataPersistenceAdapter.ensurePrime()` (`chat.js`); błąd
   **nie zniknął** — traktowany jako pre-existing / zewnętrzny względem tool-output
   fix, wymaga osobnej diagnozy ze stosem.
4. **`Commit` w „po”** jest częstszy (1390 vs 322), ale tani — nie mylić liczby
   zdarzeń z kosztem.
5. Trace zawiera tylko dane profilu; **nie zawiera treści czatów** poza tym, co
   i tak jest w repo (żadnych nowych danych).
6. Nie zmieniano `data/*` (sesja auth tylko odczytana i podpisana w pamięci).

## Komendy odtworzenia

```bash
# 1. sesja (cookie cr_session) z data/sessions.json — bez zapisu
node -e "…"                          # patrz .tmp/ui-freeze-52 (skrypt sesji)
# 2. realny trace
node .tmp/ui-freeze-52/live-trace.mjs desktop .tmp/ui-freeze-52/traces/Trace-after-desktop.json .tmp/ui-freeze-52/desktop-sidecar.json
node .tmp/ui-freeze-52/live-trace.mjs mobile  .tmp/ui-freeze-52/traces/Trace-after-mobile.json  .tmp/ui-freeze-52/mobile-sidecar.json
node .tmp/ui-freeze-52/live-trace.mjs offline .tmp/ui-freeze-52/traces/Trace-after-offline.json .tmp/ui-freeze-52/offline-sidecar.json
node .tmp/ui-freeze-52/live-trace.mjs archive .tmp/ui-freeze-52/traces/Trace-after-archive.json .tmp/ui-freeze-52/archive-sidecar.json
# 3. analiza (ten sam kod dla baseline i „po”)
python3 .tmp/ui-freeze-52/analyze_trace.py .tmp/ui-freeze-52/traces/Trace-after-desktop.json .tmp/ui-freeze-52/desktop-after-analysis.json
python3 .tmp/ui-freeze-52/analyze_trace.py /tmp/tracew/Trace-20261006T151320.json/Trace-20261006T151320.json .tmp/ui-freeze-52/baseline-analysis.json
# 4. long taski per faza
python3 .tmp/ui-freeze-52/extract_phases.py .tmp/ui-freeze-52/traces/Trace-after-desktop.json
```

## Ocena kryteriów etapu 5 (dla liścia 5.2)

| Kryterium | Wynik | Dowód |
| --- | --- | --- |
| Slice pracy JS ~8 ms z możliwością yield | **PASS** | typowe klastry 8–14 ms; max replay **30,2 ms** (<50 ms) po fixie tool output |
| Brak >50 ms w naprawianych ścieżkach render pipeline | **PASS** | apply 1 MB tool output: **118,9 ms → 30,2 ms** (realny trace po fixie) |
| Otwarcie/pin sidebara ≤50 ms pracy main thread | **PASS** | max zadanie fazy C = **26,2 ms**, 0 >50 ms |
| Input latency ≤200 ms | **PASS** | max interakcja **48 ms**, kolejka **20 ms** |
| Pojedyncza karta / długa tura nie omija limitu DOM | **PASS** | 80 kart (cap), nodes ~20,3 tys.; raport 800 KB 33 karty/17,9 tys. |
| Brak sekundowych zatorów | **PASS** | max long task **143,5 ms** |
| Brak regresji pollingu | **PASS (pośrednio)** | `history.poll.apply` max 0,1 ms w snapshotach; long taski pollu brak |

## Trace po fixie tool output (2026-10-06)

```bash
node .tmp/ui-freeze-52/live-trace.mjs desktop \
  .tmp/ui-freeze-52/traces/Trace-after-fix-desktop.json \
  .tmp/ui-freeze-52/desktop-fix-sidecar.json
python3 .tmp/ui-freeze-52/analyze_trace.py \
  .tmp/ui-freeze-52/traces/Trace-after-fix-desktop.json \
  .tmp/ui-freeze-52/desktop-fix-analysis.json
node --test tests/ui-freeze-tool-call-output-preview.test.js
```
