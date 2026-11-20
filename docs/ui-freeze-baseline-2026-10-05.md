# UI freeze — instrumentacja i baseline (0.1)

Data: 2026-10-05. Zakres: podzadanie 0.1 etapu 0 planu
`docs/ui-freeze-trace-2026-10-05.md`. To jest **instrumentacja i pomiar
bazowy przed zmianą zachowania UI** — żadna ścieżka renderu, pollingu ani
cache nie została zmieniona.

Powiązane materiały:

- diagnoza i plan: `docs/ui-freeze-trace-2026-10-05.md`,
- audyt trace: `docs/ui-freeze-trace-2026-10-05-opus55.md`,
- review planu: `docs/ui-freeze-plan-review-2026-10-05-opus55.md`.

## Jak włączyć (domyślnie wyłączone)

Diagnostyka pozostaje opt-in i bez treści czatów:

- `?uiFreezeDiag=1` w URL albo `localStorage['cretli-ui-freeze-diag'] = '1'`
  (Debug modal w zakładce Logs ustawia ten sam klucz),
- Logs → filtr **freeze**: linie `ui-freeze-trace` z komunikatem
  `freeze-counters:snapshot` oraz `freeze-counters:span`.

Gdy flaga jest wyłączona, `getUiFreezeCounters()` zwraca `null`, a każde
miejsce wywołania jest no-opem — ścieżka produkcyjna zachowuje poprzedni koszt.
Flaga jest odczytywana raz i cache'owana (`true` na stałe; przy `false` odczyt
URL/localStorage jest dławiony do raz na sekundę), żeby komparator boot-cache
nie czytał storage przy każdym porównaniu.

## Nowe spany i liczniki

Spany (czas porcji) trafiają do wspólnego stosu `chatPerfBudget`, więc późniejszy
`PerformanceObserver('longtask')` potrafi przypisać długie zadanie do ścieżki,
a nie tylko zgłosić je **po** zakończeniu taska:

| Span | Miejsce | Co mierzy |
| --- | --- | --- |
| `history.poll.apply` | `chatPendingRemoteHistoryFlag` (wspólny setter/publisher) | synchroniczne zastosowanie zmiany pending (callback → `renderChatList` → cache) |
| `boot-cache.build` | `chatLocalBootCache.buildChatLocalBootCache` | sanitizacja + sortowanie >300 + odczyty map aktywności |
| `boot-cache.hydrate` | `chatController.loadChatsFromServer` | synchroniczna hydratacja listy z boot cache na starcie |
| `sidebar.layout.apply` | `sidebarLayoutSync.applyLayout` | zastosowanie layoutu (w tym wymuszony `forceRerender`) |
| `sidebar.archive.render` | `sidebarView.renderArchiveSection` | serializacja HTML listy archiwum (gdy sekcja otwarta) |

Każdy span emituje `freeze-counters:span-start` **przed** pracą i
`freeze-counters:span` po jej zakończeniu. Linia `span-start` zostaje w buforze
Logs nawet wtedy, gdy zadanie nigdy się nie kończy (zawieszenie), więc dowód nie
zależy wyłącznie od `PerformanceObserver('longtask')`, który raportuje dopiero po
zakończeniu taska.

Liczniki (narastają w oknie 1 s, zwijane w jeden `snapshot`):

| Klucz | Znaczenie |
| --- | --- |
| `ui.renders` | wywołania `renderChatList` |
| `ui.pendingRefreshes` | wywołania `onPendingHistoryChange` |
| `storage.reads` | odczyty map (`chatStore.readObjectMap`) i boot cache |
| `cache.builds` / `cache.writes` / `cache.reads` | budowy / realne zapisy / odczyty boot cache |
| `cache.hydrates` | udane hydratacje z boot cache |
| `sidebar.forceRenders` | wywołania `sidebarView.forceRerender` |
| `sidebar.layout.frames` / `.skipped` / `.stale` | ramki layoutu / bez zmian / odrzucone jako starsze |
| `poll.passes`, `poll.eligibleChats`, `poll.monitoredChats`, `poll.visibleChats` | rozmiar zbioru pollingu |
| `pending.*` | `batches`, `setTrue`, `setFalse`, `net` (= true − false), `lastBatchNet` |
| `mountedRows.last` / `.max` | zamontowane wiersze sidebara po przebiegu |
| `monitoring:<reason>\|archived=<bool>` | kwalifikacja do monitoringu: `active` / `recent` / `live` / `busy` / `waiting` / `attention`, z podziałem na `archivedAt` |
| `monitoringCandidate:<reason>\|archived=<bool>` | surowe powody przed bramką archiwum 3.1 (strona „przed”); różnica względem `monitoring:` to kwalifikacje usunięte przez bramkę (`docs/monitoring-archive-3.1.md`) |

Pełny zrzut: `window.__crUiFreeze.format()` (tekst) albo
`window.__crUiFreeze.counters()` (obiekt) w konsoli przy włączonej fladze.
`window.__crUiFreeze.flush()` domyka otwarte okno przed zamknięciem karty;
`pagehide` robi to automatycznie.

Kwalifikacja do monitoringu jest liczona w `selectMonitoredChatIds` przez
`onQualified` / `onClassified` (nowy, opcjonalny piąty argument). Na etapie 0.1
zbiór monitorowanych czatów pozostał identyczny jak przed zmianą; etap 3.1
(`docs/monitoring-archive-3.1.md`) dokłada bramkę archiwum, a
`monitoringCandidate:` pokazuje surowe przyczyny „przed”, więc widać np. ile
archiwalnych czatów wypadło przez zaległe `waiting`/`attention`.

## Baseline „przed” (z trace 2026-10-05)

Wartości z istniejącego trace i audytu (ten sam scenariusz: reload → otwarcie
archiwum → ≥20 s do pollu → input/scroll). To jest punkt odniesienia dla 3.3 i 8.3.

| Metryka | Przed (trace) | Cel |
| --- | ---: | ---: |
| Najdłuższy task po pollu | ≥11 208 ms (niedokończony) | ≤50 ms |
| Wywołania `renderChatList` na poll | ≥341 | ≤1 |
| `writeChatLocalBootCache` w oknie pollu | 10 505 ms | 0 ms w pollu |
| `readObjectMap` na budowę cache (1500 czatów) | tysiące | 2 |
| Węzły DOM po otwarciu archiwum | 115–133 tys. | ≤30 tys. (po P1-b) |
| `onSidebarLayout` inclusive | 842 ms | ≤50 ms |
| Przyrost listenerów na `renderChatList` | +1 | 0 |

## Baseline syntetyczny (ta maszyna)

Uruchomienie: `node scripts/measure-ui-freeze-baseline.mjs`. Skrypt mierzy
prawdziwe, instrumentowane ścieżki na syntetycznych danych (bez przeglądarki,
serwera i realnych czatów), więc liczby są porównywalne między powtórzeniami na
tej samej maszynie.

Środowisko: Node v22.23.2, x64/linux, mapy aktywności i last-used po 1500
wpisów, mediana z 5 powtórzeń.

| Liczba czatów | mediana `boot-cache.build` | max | `storage.reads`/budowa | wiersze w cache |
| ---: | ---: | ---: | ---: | ---: |
| 40 (mały bootstrap) | 0,06 ms | 0,57 ms | 0 | 40 |
| 300 | 0,21 ms | 0,56 ms | 0 | 300 |
| 301 | 169,73 ms | 169,94 ms | 1196 | 300 |
| 1000 | 558,66 ms | 570,59 ms | 3992 | 300 |
| 1500 | 828,43 ms | 836,61 ms | 5992 | 300 |

Cold-start (odczyt i parsowanie snapshotu):

| Liczba czatów | mediana parse | max | JSON |
| ---: | ---: | ---: | ---: |
| 40 | 0,04 ms | 0,19 ms | 7 712 B |
| 300 | 0,29 ms | 0,33 ms | 57 712 B |

Wniosek: próg 300 działa jak w diagnozie — do 300 budowa nie dotyka storage,
powyżej 300 koszt sortowania i odczytów map rośnie liniowo. Przy 1500 czatach
pojedyncza budowa to ~0,83 s na tej maszynie, co przy renderze na każdy czat
odtwarza ścieżkę blokady z trace. To potwierdza, że instrumentacja liczy te same
odczyty, które wskazał profil CPU.

## Budżet pierwszego malowania (mały bootstrap)

Budżet liczbowy dla **małego bootstrapu (≤40 wierszy)** na tej maszynie:

- synchroniczne parsowanie snapshotu: **≤5 ms** (zmierzone 0,04 ms mediany,
  0,19 ms max) i snapshot **≤64 KB** (zmierzone 7,7 KB),
- pierwsze malowanie listy z cache (parse + hydratacja + render sidebara):
  **≤100 ms** przy zimnym starcie offline.

Część „≤5 ms / ≤64 KB” jest zmierzona skryptem powyżej. Budżet pierwszego
malowania 100 ms jest celem do potwierdzenia pierwszym nagraniem w przeglądarce;
samo parsowanie to <1% tego budżetu, więc reszta należy do hydratacji i renderu.
Wartość należy zweryfikować na tym samym urządzeniu i viewportcie przed 5.3.

## Bootstrap synchroniczny (5.3)

Stałe w kodzie (`app_front/features/chat/chatLocalBootSync.js`), źródło liczb: sekcja
«Budżet pierwszego malowania (mały bootstrap)» powyżej:

| Parametr | Wartość | Uzasadnienie |
| --- | ---: | --- |
| **N** (max wierszy sync) | **40** | baseline 0.1: «mały bootstrap (≤40 wierszy)» |
| **Limit bajtów JSON sync** | **65 536 B (64 KB)** | baseline 0.1: snapshot ≤64 KB (7,7 KB przy 40 wierszach) |
| **Max wierszy pełnego cache (IDB)** | **300** | `CHAT_LOCAL_BOOT_CACHE_MAX_CHATS` — bez zmian |

Klucz localStorage: `cretli-chat-boot-sync-v1` (zawsze sync, nigdy IDB). Pełny snapshot:
`cretli-chat-boot-cache-v1` w IDB; legacy w localStorage migrowany idempotentnie
(`chatLocalBootLegacyMigration.js`) — usunięcie źródła dopiero po commicie IDB. Reszta
listy po pierwszym malowaniu: `chatLocalBootAsyncHydrate.js` + `schedulerYield` (~8 ms).

## Scenariusz i parametry powtórzenia

Zachować dla 3.3 i 8.3 (ten sam zbiór danych, urządzenie i viewport):

1. Włącz `?uiFreezeDiag=1`, otwórz DevTools → Performance, wyczyść Logs.
2. **Reload** (cold start). Notuj `boot-cache.hydrate`, `boot-cache.build`,
   `boot-cache.hydrate.attempts` i wiersze.
3. Otwórz sekcję **archiwum** (dwa szybkie kliknięcia, aby sprawdzić coalescing).
   Notuj `sidebar.layout.frames/skipped/stale` i `mountedRows`.
4. Czekaj **≥20 s** na poll (interwał 15 s + start 1,5 s). Notuj
   `poll.*`, `pending.*`, `history.poll.apply`, `cache.builds/writes`,
   `storage.reads`, `monitoring:*`.
5. W trakcie i po pollu wykonaj **input i scroll** (wpisz znak, przewiń listę),
   żeby potwierdzić responsywność między porcjami.
6. **Offline cold start**: ustaw offline (DevTools → Network) i powtórz reload.
   Zmierz czas do pierwszego malowania listy z cache.
7. Zapisz trace (`Trace-*.json`) i zrzut `window.__crUiFreeze.format()`.
   Trace trzymać poza repo (jak `Trace-20261005T225710.json`) i podać w raporcie
   ścieżkę, wersję kodu (`git rev-parse HEAD`), viewport i typ urządzenia.

Rozróżnienie pomiarów: `history.poll.apply` = zastosowanie pollu w UI,
`boot-cache.build` = budowa snapshotu, `boot-cache.hydrate` = hydratacja startowa,
`sidebar.archive.render` = pełny render HTML archiwum (osobny span w snapshot).

## Ograniczenia tego baseline'u

- **Nagranie w przeglądarce (2026-10-06, próba 3):** logowanie lokalne
  bez hasła działa. Panel Browser tego czatu otworzył
  `https://localhost:3011/?uiFreezeDiag=1` i wszedł do aplikacji bez formularza
  hasła (token tylko w pamięci procesu, nagłówek kontekstu Chromium).
  Viewport: **390×844**, DPR 2, dotyk (domyślny profil panelu). **HEAD:**
  `53551b9fd4402af56c5064c3c43f656144e39445` (drzewo robocze z instrumentacją,
  bez commita). Sekcja archiwum (942 wiersze) otworzyła się, lista dała się
  przewinąć, a po zamknięciu szuflady jeden znak w composerze pojawił się od
  razu i został skasowany (nic nie wysłano). Poll HTTP (`history-revisions` +
  `history-batch`) chodził co ~15 s; po otwarciu archiwum kolejna porcja
  ruszyła dopiero po ~28 s, a kilka żądań z tej porcji zakończyło się w tej
  samej milisekundie (`history-batch` ~832 ms) — ślad blokady głównego wątku,
  nie osobny trace CPU. `wss://localhost` padał z `ERR_NAME_NOT_RESOLVED`
  (okno „Chat connection lost”); poll szedł po HTTP. Narzędzia Browser nie
  wykonują skryptu, więc nie ma zrzutu `window.__crUiFreeze.format()` ani
  pliku `Trace-*.json`. Budżet ≤100 ms pierwszego malowania pozostaje celem,
  nie zmierzoną wartością z UI.
- Pełnego trace Performance (`Trace-*.json`) nadal nie ma. Punkt „przed”
  zostaje z trace 2026-10-05; próba 3 dodaje tylko czasy z panelu Network
  na żywych danych (archiwum 942 wiersze) i ten sam viewport.
- Liczby syntetyczne są danymi, nie profilem CPU. Licznik `storage.reads`
  liczy wywołania `readObjectMap`/odczytu boot cache; surowe `Storage.getItem`
  może być do ~2× większe przez aliasy kluczy (skrypt raportuje oba).
- Przy 1500 czatach pojedyncza budowa jest bliska oknu 1 s, więc snapshot
  licznika może objąć nieco mniej odczytów niż surowy licznik (patrz kolumny
  w tabeli).

## Testy

- `node --test tests/ui-freeze-counters.test.js` — liczniki, spany, pending
  netto, monitoring z podziałem na `archivedAt`, klasyfikator i integracja
  boot-cache.
- `node --test tests/sidebar-layout.test.js` — brak regresji layoutu.
- `node --test tests/chat-history-sync-poll.test.js` — brak regresji pollu.
- `node --test tests/chat-local-boot-cache.test.js` — brak regresji cache.
- `node scripts/measure-ui-freeze-baseline.mjs` — tabela powyżej.
