# Diagnoza `TypeError: Cannot read properties of undefined (reading 'catch')` — 2026-10-07

Status: **nie reprodukuje się** w aktualnym drzewie (HEAD `79b8329` + brudne zmiany)
w porównywalnym scenariuszu UI (desktop 2×, archive 2×, mobile 1×, offline 1×).
Dokument zbiera metodę, surowe liczby, korelację z `ensurePrime()` i ograniczenia.

**Strefa czasu:** wszystkie znaczniki w tym dokumencie to **UTC**, o ile nie zaznaczono inaczej.

## 1. Wniosek w jednym akapicie

W sześciu przebiegach z 2026-10-07 (desktop 2×, archive 2×, mobile 1×, offline 1×)
nie wystąpił żaden `pageerror`; `page.on('pageerror')` był uzbrojony **przed**
pierwszym `goto`, więc boot był objęty nasłuchem. Pozostałe wpisy w sidecarach to
wyłącznie timeouty kliknięć w sterowniku Playwright (`switch-back`, `panel`, `pin`) —
te same, które występowały wcześniej i które nie są błędami aplikacji. Błąd
`reading 'catch'` występował ostatni raz **2026-10-06 między 16:39:28 a 16:52:34 UTC**
(3 przebiegi desktop po 3×, mobile 2×, archive 1×, offline 2×). **Zniknął między
16:52:34 UTC 2026-10-06 a 06:22:14 UTC 2026-10-07** — w tym oknie nie ma
pośrednich przebiegów harnessu; zmieniło się m.in. drzewo robocze (commit
`017d954` o **17:34:39 UTC**, potem `79b8329` o **21:13:36 UTC**), a tuż przed
nowymi runami bundel mógł się przebudować (mtime `index.bundle.js` **06:41:47 UTC**,
`sw.js` **06:42:20 UTC** — patrz sekcja 3). Nie da się przypisać zniknięcia
wyłącznie do `017d954`, bo commit nie odtwarza stanu WT z 16:39–16:52 i nie
zmienia samego faktu braku reprodukcji na HEAD. Wewnętrzny `.catch(() => {})` w
`ensurePrime()` był już w snapshotach bundla z **10:33 / 10:51 UTC** 2026-10-06,
a próba naprawy przez `.catch` na łańcuchu `ensurePrime()` w `chat.js` **nie usunęła**
błędu (przebieg `desktop-fix` o 16:52:34 UTC nadal 3× pageerror). Historycznego
`file:line` nie ma (stare sidecary bez `stack`). Audyt HEAD: **brak** bare-variable
`x.catch` poza trzema bezpiecznymi miejscami; klasa **`fn(...).catch(`** (wynik
wywołania zwraca `undefined`) **nie była badana wyczerpująco** (123 wystąpienia
w `app_front/**`) — patrz sekcja 6.

## 2. Metoda

| Aspekt | Wartość |
| --- | --- |
| Serwer | żywy `https://127.0.0.1:3011` (health 200 w czasie runów 2026-10-07) |
| Przeglądarka | `/usr/bin/chromium`, `playwright-core`, headless, `--no-sandbox --disable-dev-shm-usage --disable-gpu --ignore-certificate-errors` |
| Auth | cookie `cr_session` z `.tmp/ui-freeze-52/cookie.txt`; zweryfikowane `curl`: `GET /api/chats` = 200 z cookie, 401 bez |
| Skrypt | `.tmp/ui-freeze-pageerror/live-trace-stack.mjs` (kopia `live-trace.mjs`; `pageerror` zapisuje `stack: e.stack`) |
| Zapis | sidecary: `.tmp/ui-freeze-pageerror/run<N>-<scenario>.json`, trace: opcjonalnie `/tmp/fix-*.trace.json`, logi: `run<N>-<scenario>.log` |
| Scenariusze | `desktop` 2×, `archive` 2×, `mobile` 1×, `offline` 1× |
| Widok | desktop 1920×525, mobile 390×844 DPR 2 |

Kolejność uzbrojenia nasłuchu w skrypcie: `context.newPage()` →
`page.on('pageerror', …)` → `addInitScript` → dopiero potem `goto(...)`.
Dzięki temu pierwsza nawigacja i boot są w pełni objęte nasłuchem.

### Tożsamość bundla (runy 2026-10-07)

| Plik | sha256 | mtime (UTC) |
| --- | --- | --- |
| `public/dist/app/index.bundle.js` | `120e9287f60d34ebf7a9fe6f78389cb281a1b5bab6e001af980887b86705a7e9` | 2026-10-07 06:41:47 |
| `public/sw.js` | `22d14de23a11c6e46acf85ef6e3736011dd4b0078f52079ede0900636a16a0e7` | 2026-10-07 06:42:20 |

Bundel mógł się przebudować w oknie pracy implementera (watcher frontu) **po**
commitach z 2026-10-06 wieczorem, a **przed** pierwszym czystym runem o 06:22 UTC —
więc runy z tabeli poniżej nie muszą odpowiadać dokładnie drzewu z samego `git HEAD`
w momencie `git show`, tylko artefaktowi z `public/dist/` o powyższych sumach.

### Walidacja samego nasłuchu stosu

Ponieważ nowe przebiegi nie dały `pageerror`, zweryfikowano, że harness
**w ogóle** złapałby ten błąd wraz ze stosem. Skrypt
`.tmp/ui-freeze-pageerror/validate-pageerror-capture.mjs` wstrzykuje do strony
asynchroniczny `undefined.catch(() => {})`; wynik:

```
TypeError: Cannot read properties of undefined (reading 'catch')
    at eval (eval at evaluate (...) <anonymous>:6:22)
capturedPageerrors=1
```

Czyli dokładnie ta klasa błędu jest przechwytywana i tekst zgadza się co do znaku.
(Gdyby wyjątek wystąpił z pliku źródła, `e.stack` wskazywałby `file:line`.)

## 3. Surowe wyniki wszystkich przebiegów

Legenda: `pageerr` = liczba `pageerror` (czasy w ms od startu scenariusza),
`other` = pozostałe błędy sidecara, `long` = `longtask` z `PerformanceObserver`
(tylko orientacyjnie, liczone od `addInitScript`).

| Data / etykieta | Scenariusz | start (UTC) | czas | pageerror | inne błędy | longtaski |
| --- | --- | --- | ---: | --- | --- | --- |
| 2026-10-06 baseline | desktop | 16:39:28.728 | 43163 ms | **3** @ 480, 21897, 28738 | 3× console (SSL) | 3 (max 143 ms) |
| 2026-10-06 baseline | mobile | 16:40:20.715 | 43577 ms | **2** @ 482, 34506 | 3× timeout (pin, panel, panel-back) | 1 (max 91 ms) |
| 2026-10-06 baseline | archive | 16:42:05.846 | 12115 ms | **1** @ 522 | 0 | 4 (max 199 ms) |
| 2026-10-06 baseline | offline | 16:43:08.330 | 17343 ms | **2** @ 513, 8046 | 4× console (ERR_INTERNET_DISCONNECTED) | 1 (max 86 ms) |
| 2026-10-06 „po 1. fixie” | desktop | 16:52:34.392 | 43374 ms | **3** @ 653, 21857, 28658 | **0** console | 4 (max 168 ms) |
| 2026-10-06 docs (kopia) | archive | 16:42:05.846 | 12115 ms | **1** @ 522 | 0 | 4 (max 199 ms) |
| 2026-10-07 retest | desktop | 06:22:14.240 | 56140 ms | 0 | 1× timeout (switch-back) | 4 (max 130 ms) |
| **2026-10-07 run1** | **desktop** | 06:53:11.621 | 122752 ms | **0** | 3× timeout (switch-back, panel, panel-back) | 2 (max 175 ms) |
| **2026-10-07 run2** | **desktop** | 06:55:31.439 | 57559 ms | **0** | 1× timeout (switch-back) | 11 (max 615 ms) |
| **2026-10-07 run1** | **archive** | 06:56:34.950 | 12121 ms | **0** | 0 | 4 (max 193 ms) |
| **2026-10-07 run1** | **mobile** | 06:56:52.246 | 42907 ms | **0** | 3× timeout (pin, panel, panel-back) | 2 (max 153 ms) |
| **2026-10-07 run1** | **offline** | 07:07:12.431 | 17006 ms | **0** | 4× console (ERR_INTERNET_DISCONNECTED) | 1 (max 82 ms) |
| **2026-10-07 run2** | **archive** | 07:07:33.485 | 11678 ms | **0** | 0 | (jak run1-archive) |

**Weryfikacja liczbowa (sidecar `errors` z `kind: pageerror`):** wszystkie sześć
plików `run1-desktop`, `run2-desktop`, `run1-archive`, `run1-mobile`, `run1-offline`,
`run2-archive` → **0** pageerror.

Uwagi:

- Kopie w `docs/ui-freeze-acceptance-2026-10-06-artifacts/` mają **identyczny**
  `startedAt` co `.tmp/ui-freeze-52/` — to kopie, nie osobne przebiegi.
- Timeouty `switch-back`/`panel`/`pin` są artefaktem harnessu (lokalizator czeka
  na element w trakcie nawigacji/animacji), występowały też na drzewie z
  pageerror (mobile 2026-10-06), więc nie są regresją.
- `run2` desktop ma 11 longtasków i max 615 ms — to zmienność dev-bundle
  (`EvaluateScript`) i obciążenie maszyny, nie ścieżka błędu; brak pageerror.
- **Niediagnostyczne:** `grep ExceptionThrown` w pliku trace CDP daje 0 także dla
  starych trace’ów z znanym pageerror w sidecarze — nie używać tego jako dowodu
  braku wyjątku.

### Gdzie błąd wystąpił ostatnio (2026-10-06)

| Scenariusz | start (UTC) | liczba | czasy pageerror (ms) |
| --- | --- | ---: | --- |
| desktop | 16:39:28 | 3 | 480 (boot), 21897, 28738 |
| mobile | 16:40:20 | 2 | 482 (boot), 34506 |
| archive | 16:42:05 | 1 | 522 (boot) |
| offline | 16:43:08 | 2 | 513 (boot), 8046 |
| desktop „po 1. fixie” | 16:52:34 | 3 | 653 (boot), 21857, 28658 |

Czasy 480–653 ms to boot SPA; 21857–28738 ms to nawigacje do czatów w fazach
F/G. Ostatni znany przebieg z błędem: **2026-10-06 16:52:34 UTC** (`desktop-fix`).

### Okno zniknięcia (bez dowodu „naprawił commit X”)

| Zdarzenie | UTC |
| --- | --- |
| Ostatni pageerror (`desktop-fix`) | 2026-10-06 16:52:34 |
| Commit `017d954` (sidebar rewrite checkpoint) | 2026-10-06 17:34:39 |
| Commit `79b8329` | 2026-10-06 21:13:36 |
| Pierwszy czysty run (retest desktop) | 2026-10-07 06:22:14 |
| mtime `index.bundle.js` / `sw.js` | 2026-10-07 06:41:47 / 06:42:20 |

Między 16:52 a 06:22 **brak** zapisanych przebiegów — korelacja z commitem to
hipoteza organizacyjna, nie dowód regresji/naprawy.

## 4. Stack

Nowe przebiegi **nie złapały żadnego `pageerror`**, więc nie ma nowego stosu do
przedstawienia. Walidacja harnessu (sekcja 2) potwierdza, że gdyby błąd wystąpił,
zostałby zapisany razem ze stosem. Żaden ze starych sidecarów (2026-10-06) nie
zawiera pola `stack` — `live-trace.mjs` zapisywał tylko `text`, dlatego
historycznego `file:line` nie da się odtworzyć z artefaktów.

## 5. Korelacja z `ensurePrime()`

### Aktualny stan (HEAD, plik czysty — nie ma go w `git status`)

`app_front/features/chat/chatPersistenceIdbAdapter.js:202-212`:

```js
function ensurePrime() {
  if (cacheReady) return Promise.resolve();
  if (!primePromise) {
    primePromise = primeCacheFromIdb()
      .catch(() => {})          // linia 206
      .finally(() => {
        if (!cacheReady) primePromise = null;
      });
  }
  return primePromise;
}
```

`ensurePrime()` **zawsze** zwraca `Promise`: albo `Promise.resolve()`, albo
`primePromise` (które jest wynikiem łańcucha `async primeCacheFromIdb()`
→ `.catch` → `.finally`). Nie ma ścieżki zwracającej `undefined`.

Wywołania:

| Miejsce | Kod | Bezpieczeństwo |
| --- | --- | --- |
| `app_front/chat.js:3306` | `void chatMetadataPersistenceAdapter.ensurePrime().then(async () => { … }).catch(() => {})` (`.catch` w linii 3318) | `.catch` na wyniku `.then()` (Promise); gdyby `ensurePrime()` zwróciło `undefined`, błąd byłby **`reading 'then'`**, nie `'catch'` |
| `app_front/features/chat/chatController.js:302-303` | `} else if (typeof adapter.ensurePrime === 'function') { await adapter.ensurePrime(); }` w bloku `try { … } catch (_) {}` | guard na istnienie metody + `await` w `try/catch` |

### Kiedy pojawił się `.catch` (git)

- Plik `app_front/features/chat/chatPersistenceIdbAdapter.js` jest **nowy** w
  commicie `017d954` (**2026-10-06 17:34:39 UTC**); to pierwszy commit dotykający
  tego pliku (`git log -S 'primePromise'`). W wersji z commita `.catch(() => {})`
  już jest, a `git diff 53551b9 017d954` pokazuje plik jako `new file` — wcześniej
  `ensurePrime` nie istniało w `app_front/**`.
- **Ważne zaprzeczenie hipotezy „`.catch` w `ensurePrime()` naprawił błąd”:**
  snapshots webpacka z drzewa roboczego z 2026-10-06
  (`.tmp/chat-metadata-idb-e2e/harness.js`, mtime **10:33 UTC** oraz
  `.tmp/chat-history-sync-e2e/harness.js`, mtime **10:51 UTC**) zawierają
  `ensurePrime` z tym samym `.catch(() => {})`. Oba powstały **przed** ostatnimi
  awariami (16:39–16:52 UTC). Czyli wewnętrzny `.catch` był obecny już w czasie, gdy
  błąd występował, i sam nie mógł go usunąć.
- Jedyna udokumentowana próba naprawy „po fakcie” to dodanie `.catch` na
  **łańcuchu** `ensurePrime()` w `chat.js` (opisane w
  `docs/ui-freeze-acceptance-2026-10-06.md`, sekcja „Ograniczenia”, pkt 3).
  Przebieg `desktop-fix` o 16:52:34 UTC (już „po 1. fixie”) nadal ma 3× pageerror —
  ta próba **nie zadziałała**.

Wniosek z korelacji: zniknięcie błędu **czasowo** pokrywa się z dużą przebudową
persistence/bootu/sidebara i ewentualnym przebudowaniem bundla, **nie** z samym
`.catch` w `ensurePrime()`. Związek przyczynowy z konkretną linią w `ensurePrime()`
nie jest wsparty dowodami — dane z 10:33 UTC / 16:52 UTC mu przeczą.

## 6. Audyt `promise.catch` na wartościach mogących być `undefined`

Wyjątek `reading 'catch'` oznacza odbiorcę `.catch` równy `undefined`. W JS są
trzy osobne klasy miejsc:

1. **Bare-variable** — `ident.catch(` (identyfikator, nie kończy się `)`).
2. **Wieloliniowy łańcuch** — poprzednia linia kończy się `)`, następna `.catch(`.
3. **Wynik wywołania** — `fn(...).catch(` — **jedyna klasa, w której wywołanie
   może zwrócić `undefined` i dać dokładnie ten TypeError** (w przeciwieństwie do
   `undefined.then`, które dałoby `reading 'then'`).

Przeskanowano `app_front/**/*.js` z pominięciem bundle (`bundle|dist|vendor|node_modules`).

### 6a. Bare-variable (skrypt `audit-catch.mjs`) — 3 wystąpienia, wszystkie bezpieczne

| Plik:linia | Odbiorca | Dlaczego bezpieczny |
| --- | --- | --- |
| `app_front/App.js:2093` | `sidebarWorkspaceRender.catch(() => {})` | łańcuch `ensureWorkspacesListLoaded().then(...).then(...)` — Promise |
| `app_front/app/appShell/workspaceContext.js:385` | `const write = workspaceWriteQueue.catch(() => {}).then(...)` | `workspaceWriteQueue` zainicjowane `Promise.resolve()` (linia 35) |
| `app_front/features/chat/chatHistoryHydrationLive.js:101` | `await pending.catch(() => {})` | `pending = chat._sdkHistoryReplaySettlePromise`; `if (!pending) return;` (linia 99) |

### 6b. Wieloliniowy `.catch` (`audit-catch-multiline.mjs`)

- **0** przypadków bare-variable (wszystkie 99 wieloliniowych `.catch` domykają
  łańcuch wywołania `)`),
- `.catch` po optional chainingu (`?.(…)?.catch`): **0**,
- `public/index.html` / `public/login.html`: `.catch` na `fetch` / `Promise.all` /
  `navigator.serviceWorker.register` — bezpieczne,
- historyczne bundle 10:33 / 10:51 UTC: **0** bare-variable `.catch`.

### 6c. Wynik wywołania `fn(...).catch(` — **nie wyczerpująco**

Skrypt `audit-catch-call-result.mjs` zlicza **123** wystąpienia w `app_front/**`.
Pełna analiza „czy callee zawsze zwraca Promise” **nie została wykonana** dla
całego drzewa.

**Skoncentrowany przegląd ścieżki boot / nawigacji** (pliki ładowane wcześnie,
pageerror ~480–653 ms i ~22–29 s):

| Plik:linia | Wzorzec | Ocena (HEAD) |
| --- | --- | --- |
| `chat.js:3306–3318` | `ensurePrime().then(…).catch` | `.catch` na Promise z `.then`; `undefined` z `ensurePrime()` dałoby błąd na `.then` |
| `sidebarView.js:2217` | `Promise.resolve(requestLoadArchivedChats()).catch` | owinięte w `Promise.resolve` |
| `chat.js:4833` | `(async () => { … })().catch` | IIFE async → zawsze Promise |
| Pozostałe `api.*(…).catch` / `void mirrorSdk…` w `chat.js` | typowe API | w HEAD moduł `api` zwraca Promise z `fetch`; **historyczny WIP mógł mieć inne helpery** — niezweryfikowane bisectem |

**Wniosek audytu (ściśle):** na HEAD **nie ma** bare-variable kandydata na
`undefined.catch`. Klasa **call-result nie jest wykluczona** — bez stosu z awarii
i bez bisect na drzewie z 16:52 UTC nie wskazujemy pojedynczego `file:line`.
Nie twierdzimy „brak realnych kandydatów w całym repo”.

## 7. Ograniczenia

1. **Brak stosu historycznego błędu.** Stare sidecary nie mają `stack`; nie da się
   wskazać `file:line` z 2026-10-06.
2. **Drzewo robocze z czasu awarii nie jest w git.** Ostatnie awarie (16:39–16:52 UTC)
   zdarzyły się na niecommitowanej wersji working tree; warstwa IDB weszła do repo
   dopiero w `017d954`. Nie da się zrobić wiarygodnego `git bisect` na tej ścieżce.
3. **Brak reprodukcji przy wymuszonym błędzie.** Nie dodano testu regresyjnego w
   `tests/`, bo warunek zadania („jeśli `pageerror` wystąpi”) nie został spełniony;
   `tests/chat-persistence-idb-queue.test.js` (8/8 pass) nie ujawnia wyjątku.
4. **Hipoteza SSL/SW jako główna przyczyna — obalona przez własne dane.** Baseline
   desktop miał console SSL, ale `desktop-fix` (16:52:34 UTC) ma **0** błędów
   console i nadal **3× pageerror**. Harness od początku używa
   `--ignore-certificate-errors` (`live-trace.mjs:79`, `live-trace-stack.mjs:79`), więc
   różnica baseline vs fix **nie** tłumaczy samego `reading 'catch'`. SW/offline
   nadal wpływa na timing bootu — scenariusz **offline** na 2026-10-07 dał **0**
   pageerror (vs 2× na baseline 2026-10-06), co wspiera brak reprodukcji, ale nie
   identyfikuje starej linii kodu.
5. **Bundel vs git.** Runy 2026-10-07 mogły używać `public/dist/` nowszego niż
   czysty diff HEAD w chwili commita (mtime 06:41 UTC).

## 8. Wniosek

- **Nie reprodukuje się** na HEAD `79b8329` + brudne zmiany w porównywalnym
  scenariuszu: desktop 2×, archive 2×, mobile 1×, offline 1× — **łącznie 0 pageerror**.
- Ostatnie znane wystąpienie: **2026-10-06 16:39–16:52 UTC**; zniknięcie między
  **16:52:34 UTC 2026-10-06** a **06:22:14 UTC 2026-10-07** bez przebiegów pośrednich.
- Korelacja z `.catch` w `ensurePrime()`: **przeczona przez dane** (snapshots 10:33 UTC,
  failed fix 16:52 UTC).
- **Ryzyko resztkowe:** niskie na obecnym harnessie, niezerowe teoretycznie —
  klasa `fn(...).catch(` nieprzejrzana w 123 miejscach, brak stosu historycznego,
  brak bisect. Nawrót: `live-trace-stack.mjs` ze zapisem `stack`.

## 9. Artefakty i odtworzenie

Sidecary i logi (gitignored `.tmp/`):

```
.tmp/ui-freeze-pageerror/run1-desktop.json / .log   (desktop #1, 0 pageerror)
.tmp/ui-freeze-pageerror/run2-desktop.json / .log   (desktop #2, 0 pageerror)
.tmp/ui-freeze-pageerror/run1-archive.json / .log   (archive #1, 0 pageerror)
.tmp/ui-freeze-pageerror/run2-archive.json          (archive #2, 0 pageerror)
.tmp/ui-freeze-pageerror/run1-mobile.json  / .log   (mobile,    0 pageerror)
.tmp/ui-freeze-pageerror/run1-offline.json          (offline,   0 pageerror)
.tmp/ui-freeze-pageerror/summarize-runs.mjs
.tmp/ui-freeze-pageerror/audit-catch.mjs
.tmp/ui-freeze-pageerror/audit-catch-multiline.mjs
.tmp/ui-freeze-pageerror/audit-catch-call-result.mjs
.tmp/ui-freeze-pageerror/audit-catch-generic.mjs
.tmp/ui-freeze-pageerror/validate-pageerror-capture.mjs
```

Komendy:

```bash
# przebiegi (sidecar + trace)
node .tmp/ui-freeze-pageerror/live-trace-stack.mjs desktop .tmp/ui-freeze-pageerror/run1-desktop.trace.json .tmp/ui-freeze-pageerror/run1-desktop.json
node .tmp/ui-freeze-pageerror/live-trace-stack.mjs desktop .tmp/ui-freeze-pageerror/run2-desktop.trace.json .tmp/ui-freeze-pageerror/run2-desktop.json
node .tmp/ui-freeze-pageerror/live-trace-stack.mjs archive .tmp/ui-freeze-pageerror/run1-archive.trace.json .tmp/ui-freeze-pageerror/run1-archive.json
node .tmp/ui-freeze-pageerror/live-trace-stack.mjs archive /tmp/fix-archive.trace.json .tmp/ui-freeze-pageerror/run2-archive.json
node .tmp/ui-freeze-pageerror/live-trace-stack.mjs mobile  .tmp/ui-freeze-pageerror/run1-mobile.trace.json  .tmp/ui-freeze-pageerror/run1-mobile.json
node .tmp/ui-freeze-pageerror/live-trace-stack.mjs offline /tmp/fix-offline.trace.json .tmp/ui-freeze-pageerror/run1-offline.json

# tabele i audyty
node .tmp/ui-freeze-pageerror/summarize-runs.mjs
node .tmp/ui-freeze-pageerror/audit-catch.mjs
node .tmp/ui-freeze-pageerror/audit-catch-multiline.mjs
node .tmp/ui-freeze-pageerror/audit-catch-call-result.mjs
node .tmp/ui-freeze-pageerror/validate-pageerror-capture.mjs

sha256sum public/dist/app/index.bundle.js public/sw.js

node --test tests/chat-persistence-idb-queue.test.js   # 8/8 pass
```

Nie zmieniano `app_front/**` ani `lib/**`. Nie commitowano ani nie pushowano.
