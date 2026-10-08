# Archiwum sidebaru — reprodukcja freeze i brak ikon (2026-10-06)

Todo: `19d46be5-8442-419d-b19b-0a47880bb52f` — „Archiwum sidebaru: odtworzyć freeze i brak ikon".

Branch: `next/2026-09-28`, HEAD: `79b8329`. Runda 4 (fix finalny).

## Metoda (spec pomiarowy)

Opt-in Playwright: `tests/e2e/sidebar-archive-expand.spec.js` (`CHAT_E2E_ARCHIVE=1`).

- **Hermetyczność serwera:** dedykowany port + `CHAT_E2E_AUTH_DIR` / `CHAT_E2E_HOME_DIR`.
  Katalog czatów może być współdzielony z `data/` (`hermeticSharedCatalog: true`).
- **Przebieg kontrolny (r4, BLOCKING-1):** `CHAT_E2E_ARCHIVE_CONTROL=1` + `--trace=off` na CLI:
  brak CDP `Profiler`, klik przez `page.evaluate` (bez `locator.scrollIntoViewIfNeeded`),
  bez fazy scrolla seeda / screenshotów / cpuprofile. Pomiar wyłącznie obserwatorami w stronie
  (`PerformanceObserver` `longtask` + `type:'event'`, MutationObserver + rAF).
- **Przebieg instrumentowany:** CDP Profiler + locator click + scroll seeda (porównanie).

### Komendy

```bash
# Kontrolny (r4)
CHAT_E2E_ARCHIVE=1 CHAT_E2E_ARCHIVE_CONTROL=1 CHAT_E2E_PORT=3412 \
CHAT_E2E_AUTH_DIR=.tmp/e2e-auth-3412 CHAT_E2E_HOME_DIR=.tmp/e2e-home-3412 \
CHAT_E2E_CHROMIUM_EXECUTABLE_PATH=/path/to/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell \
PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright \
npx playwright test tests/e2e/sidebar-archive-expand.spec.js --config playwright.config.js --retries=0 --trace=off

# Instrumentowany (porównanie)
CHAT_E2E_ARCHIVE=1 CHAT_E2E_PORT=3413 \
CHAT_E2E_AUTH_DIR=.tmp/e2e-auth-3413 CHAT_E2E_HOME_DIR=.tmp/e2e-home-3413 \
... (jak wyżej, bez CHAT_E2E_ARCHIVE_CONTROL) \
npx playwright test tests/e2e/sidebar-archive-expand.spec.js --config playwright.config.js --retries=0

node --test tests/sidebar-archive-harness-icon.test.js \
  tests/sidebar-archive-virtualizer.test.js tests/sidebar-archive-virtual-a11y.test.js \
  tests/sidebar-archive-row-index.test.js
```

## BLOCKING-1 — rozstrzygnięcie (przebieg kontrolny r4)

**Wynik:** we **wszystkich 3** iteracjach kontrolnych (port 3412, 2026-10-07):

| iter | click→click-handled | click→list-visible | click→first-row | long task >50 ms (cała sesja) | long task w oknie klik→first-row |
| --- | --- | --- | --- | --- | --- |
| 1 | 28.0 ms | 28.0 ms | 159.2 ms | **0** | **0** |
| 2 | 20.7 ms | 20.7 ms | 142.2 ms | **0** | **0** |
| 3 | 42.8 ms | 42.8 ms | 172.8 ms | **0** | **0** |

Kryterium kontrolne spełnione: brak long taska >50 ms, `clickHandledMs` ≤100 ms w każdej iteracji.

**Porównanie instrumentowany (port 3413, ten sam HEAD):**

| iter | click→click-handled | click→first-row | long task (duration @ sinceBeforeClick) |
| --- | --- | --- | --- |
| 1 | 5.4 ms | 213.2 ms | 90 ms @ +74 ms od before-click |
| 2 | 4.9 ms | 186.6 ms | 81 ms @ +423 ms |
| 3 | 4.5 ms | 184.0 ms | 76 ms @ +436 ms |

Long taski 76–90 ms pojawiają się **tylko** przy Profilerze + locatorach + scrollu seeda; w oknie
`click→first-row` (same delty od EventTiming `click`) **nie ma** long tasków >50 ms także w runie
instrumentowanym. W r3 iter1 long task w oknie rozwinięcia korelował z `scrollIntoViewIfNeeded` /
wstrzykniętym snapshotem Playwrighta i CDP sampling — przebieg kontrolny to **udowadnia**.

Logi: `.tmp/archive-expand-control-r4.log`, `.tmp/archive-expand-instrumented-r4.log`.

## Analiza CPU profile (r2–r3, zastrzeżenia)

Profile z CDP to artefakty instrumentowanego przebiegu. **Self-time** per węzeł (suma `timeDeltas`
przypisana do węzła) jest użyteczny; **nie** agregować „total/inclusive” po pustym `url` w profilu —
puste `url` obejmuje zarówno wstrzyknięty skrypt Playwrighta (np. `visitNode`, scriptId znany z profilu),
jak i natywne/zlinkowane ramki aplikacji przypisane bez URL. Etykieta „(injected/native)” na jednej
kolumnie inclusive-time była myląca i została usunięta.

### Top self-time (PRZED, 3 profile r2 zsumowane; busy ~3761 ms)

| funkcja / węzeł | self-time | self-time % |
| --- | --- | --- |
| `(program)` | 323.5 ms | 25.8% |
| `(idle)` | 270.9 ms | 21.6% |
| `visitNode` (Playwright InjectedScript, scriptId=4) | 230.5 ms | 18.4% |
| `(garbage collector)` | 26.6 ms | 2.1% |
| `visitChild` (Playwright) | 25.5 ms | 2.0% |

Grupa archiwum (`cr-sidebar-archive-group.js`) **self-time ~0.5%** w oknie kliknięcia — nie źródło
long tasków 75–94 ms z r2/r3.

## Poprawka produktu (r4)

Tylko `cr-sidebar-archive-group.js` + `sidebarArchiveVirtualizer.js` (bez zmian `sidebarView.js`).

1. **`buildArchiveRowIndexById`** — mapa `chatId → index` raz na sync; `_measureMountedRowHeights` używa
   `Map.get` zamiast `rows.findIndex` per host (O(n·m) → O(n)).
2. **Bramka `WeakMap` sygnatury w `updated()` usunięta (BLOCKING-2).** Zysk bramki <1 ms self-time,
   ryzyko nieaktualnej ikony / ulubionej / stanu harness realne. Przywrócono `requestUpdate()` na
   każdym zamontowanym wierszu przy każdym update grupy.

## Metryki API-bound (follow-up, nie blokuje tej zmiany)

`click→first-row` **142–492 ms** (kontrolny; dolna granica z tabeli r4, górna z outliera
iteracji orkiestratora poniżej) / **184–213 ms** (instrumentowany r4) — zależy od
`GET /api/chats?includeArchived=1` (~1,2 MB decoded, ~1797 rekordów) + parse JSON + render listy.
To opóźnienie treści, nie freeze main thread w oknie reakcji UI (`click→click-handled` ≤43 ms kontrolnie).

**Outlier iter3 (orkiestrator):** long task **84 ms** zaczął się przy `+499 ms` od kliknięcia,
**~7,5 ms po first-row** — czyli w fazie **first-row → last-row** (domontowanie reszty wierszy +
layout w spowolnionej iteracji), a **nie** w reakcji immediate. Poprzednia interpretacja
„long task tuż po first-row = reakcja immediate" była błędna; obserwator longtask był
rozłączany zaraz po first-row, więc ta faza nie była objęta wcześniejszymi „0 long tasków".
`click→first-row` w tej iteracji wyniósł ~491 ms stąd long task `+499 ms`.

Follow-up (wdrożony): server-side window archiwum per workspace — `GET /api/chats?includeArchived=1
&archiveWorkspace=<workspaceFile>` zwraca teraz wiersze live + archiwalne tylko tego workspace
(`fullIndex: false`); rozwinięcie jednego group nie ciągnie już ~1797 wierszy ze wszystkich
workspace. Test warstwy route: `tests/chat-archive-scope-http.test.js`. Paginacja pozostaje opcją.

## Artefakty

- Kontrolny r4: `.tmp/archive-expand-control-r4.log`
- Instrumentowany r4: `.tmp/archive-expand-instrumented-r4.log`, `test-results/playwright/sidebar-archive-expand-*/archive-expand-summary.json`
- PRZED (r2): `.tmp/archive-przed-artifacts/`

## Zmienione pliki (r4)

- `app_front/features/sidebar/cr-sidebar-archive-group.js` — mapa indeksów; bez bramki sygnatury.
- `app_front/features/sidebar/sidebarArchiveVirtualizer.js` — `buildArchiveRowIndexById` (usunięto `archiveRowRefreshSignature`).
- `tests/e2e/sidebar-archive-expand.spec.js` — `CHAT_E2E_ARCHIVE_CONTROL`, klik in-page, retry seed 404, logi kontrolne.
- `tests/sidebar-archive-row-index.test.js` — testy mapy indeksów.
- `docs/ui-freeze-archive-repro-2026-10-06.md` — ten dokument.
