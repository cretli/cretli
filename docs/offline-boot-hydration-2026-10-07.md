# Offline bootstrap: hydratacja czatu po cold starcie (2026-10-07)

Todo: `1a336b36` — „Offline bootstrap: odtworzyć hydratację czatu”.
Zakres: realny offline cold start `?chat=<id>` po rozgrzaniu cache online.

## Cel i kryterium akceptacji

Po rozgrzaniu lokalnego cache online i przeładowaniu `?chat=c84b5a31-2091-4061-ae3f-2f59cec4703f`
z wyłączoną siecią (`context.setOffline(true)`) żądany czat MUSI się wyhydratować
z lokalnego cache (`cards > 0`, `activeChat = <id>`), a bootstrap samej powłoki (FCP)
nie liczy się jako PASS hydratacji.

## Metoda

Harness: [`scripts/offline-boot-hydration-probe.mjs`](../scripts/offline-boot-hydration-probe.mjs)
(nowy, powtarzalny). Używa `playwright-core` 1.63 i `/usr/bin/chromium`
(`--no-sandbox --ignore-certificate-errors`), istniejącej sesji z
`.tmp/ui-freeze-52/cookie.txt`, nie modyfikuje `data/`.

Scenariusz:

1. **online** dwa razy otwiera `/chat?chat=<id>` (drugi load jest już kontrolowany przez SW)
   i czeka na `cards > 0`;
2. **stan cache**: `serviceWorker.getRegistrations()` / `controller`, `caches.keys()`
   + liczba wpisów, `indexedDB.databases()`, klucze `localStorage` (`cretli*`),
   dokument `cretli-chat-boot-sync-v1` oraz wiersz `cretli-chat-boot-cache-v1` z IDB;
3. `context.setOffline(true)` i reload tego samego URL;
4. zbiera requesty (start/response/requestfailed), `console`/`pageerror`, serie pomiarów
   `cards` co 250 ms, `first-contentful-paint` oraz czas od startu nawigacji do `cards > 0`;
5. zapisuje surowy JSON + czytelny log; kończy kodem `2`, gdy czat się nie wyhydratuje.

Wariant dodatkowy (fallback): `CRETLI_CLEAR_SYNC_BEFORE_OFFLINE=1` usuwa
`cretli-chat-boot-sync-v1` przed reloadem offline, aby sprawdzić odtworzenie
synchronistycznego snapshotu z IndexedDB.

Wariant „żądany czat != aktywny” (`CRETLI_PROBE_NON_ACTIVE=1`, naprawiony w review r2/F2):
najpierw rozgrzewa `?chat=<id>` (historia w IDB), potem otwiera **inny** czat z lokalnego
snapshotu, żeby `activeChatId` różnił się od żądanego, a na offline reload wraca na
`?chat=<id>`. Harness wymaga wtedy `activeOnline != <id>` i po offline `activeChat == <id>`.
Z `CRETLI_CLEAR_SYNC_BEFORE_OFFLINE=1` wymusza dodatkowo seed z IDB + `preferChatId`.
Przed próbką offline harness robi `SETTLE_MS` (F6) i zapisuje liczbę wierszy sidebara online,
którą potem asercjonuje po offline (offline nie może pokazać pustego sidebara).

### Komendy odtworzenia

```bash
# (serwer Cretli musi działać, HMR frontu aktywny)
CRETLI_CHAT_ID=fabd16a3-8e28-4ccc-a991-671664916696 node scripts/offline-boot-hydration-probe.mjs \
  fabd16a3-8e28-4ccc-a991-671664916696 \
  .tmp/offline-hydration/fix-verify-active

# wariant: żądany czat != aktywny
CRETLI_PROBE_NON_ACTIVE=1 CRETLI_CHAT_ID=fabd16a3-8e28-4ccc-a991-671664916696 \
  node scripts/offline-boot-hydration-probe.mjs \
  fabd16a3-8e28-4ccc-a991-671664916696 \
  .tmp/offline-hydration/fix3-nonactive

# wariant: żądany czat != aktywny + brak sync doc -> seed z IDB + preferChatId
CRETLI_PROBE_NON_ACTIVE=1 CRETLI_CLEAR_SYNC_BEFORE_OFFLINE=1 \
  CRETLI_CHAT_ID=fabd16a3-8e28-4ccc-a991-671664916696 \
  node scripts/offline-boot-hydration-probe.mjs \
  fabd16a3-8e28-4ccc-a991-671664916696 \
  .tmp/offline-hydration/fix3-nonactive-seed
```

Testy jednostkowe decyzji bootu:

```bash
node tests/chat-boot-offline-decision.test.js
```

## Ustalone przyczyny

### 1) Bramka auth blokowała boot offline (przyczyna pierwotna)

`app_front/App.js` → `ensureAuthenticatedThenBoot()`. Gdy `api.getAuthStatus()`
zostało odrzucone (offline), `.catch()` pokazywał nakładkę `showBackendUnavailableOverlay()`
i ponawiał co 4 s — `bootApp()` **nigdy** nie było wołane, więc cała hydratacja
(`loadChatsFromServer` → `hydrateChatListFromLocalBootCache`) nie startowała.

### 2) Offline boot nie może nadpisać pełnego snapshotu IDB wycinkiem sync (B1)

Po bootcie offline runtime miał ≤40 wierszy z sync doc, a `persistChatListBootCache` zapisywał
ten stan jako pełny `cretli-chat-boot-cache-v1` w IDB — trwale gubiąc czaty spoza okna.
Guard `isPartialBootCacheSubsetShrink` pomija taki zapis, ale **tylko wtedy, gdy runtime jest
jawnie niepotwierdzonym wycinkiem boot cache** (`input.source === 'boot-cache'`), a nie na
podstawie progu 40 wierszy.

Poprzednia wersja (review r2, F1) opierała pominięcie na `incumbent > 40 && candidate <= 40`.
To zamrażało każdy legalny zapis po stronie serwera, który przekraczał tę granicę (np. 41→40
po usunięciu czatu): duchy zostawały w IDB na zawsze, a sync doc nie był odświeżany, bo skip
zwracał `built:false`. Dodatkowo review r2 (F2) wykazał, że guard czytał incumbent z adaptera
IDB, którego **synchronistyczny `read()` serwuje wyłącznie in-memory mirror**. Na offline cold
starcie `ensurePrime()` często nie jest wołane (legacy snapshot w localStorage skraca drogę do
IDB), więc incumbent czytał się jako `null` i wycinek 40 wierszy i tak nadpisywał snapshot.
Naprawa: `primeIncumbentBootCacheDoc()` przed decyzją guardu (`refreshMetaKeyFromIdb` albo
`ensurePrime`) oraz jawny `source` z kontrolera.

### 3) Żądany `?chat=` spoza okna 40 nie był pinowany ani hydratowany z IDB

Seed z IDB nie znał URL; brak w sync doc kończył hydratację przed `forceIdb`. Naprawa:
`preferChatId` w seed/sync oraz fallback IDB w kontrolerze. Gałąź `preferChatId`/`forceIdb`
była jednak martwa: `loadChatsFromServer` bumpuje `listRevision` jeszcze w tym samym
synchronistycznym przebiegu, co unieważniało przechwycony guard hydratacji. Hydratacja
`forceIdb` jest teraz odroczona o mikrotask (guard łapany po bumpie), ma `.catch` i nie
nadpisuje aktywnego czatu, jeśli użytkownik zdążył go zmienić.

### 4) Synchronistyczny snapshot w localStorage nigdy nie powstawał (przyczyna wtórna)

`buildChatLocalBootSyncDoc()` wkładał do dokumentu `fullSignature`, będący
`JSON.stringify` **całego** snapshotu (v, activeChatId, workspaceContext, workspaces,
wszystkie czaty) — w tym środowisku ~78 KB dla 120 czatów. Limit dokumentu to
64 KB (`CHAT_LOCAL_BOOT_SYNC_MAX_BYTES = 65536`), więc
`writeChatLocalBootSync()` zwracał `false`, a `cretli-chat-boot-sync-v1` nie pojawiał
się w localStorage. `hydrateChatListFromLocalBootCache()` czyta wyłącznie ten
synchronistyczny dokument i przy jego braku zwracał `false` **przed**
`scheduleAsyncBootCacheHydration()`, więc nawet fallback po IDB nie był uruchamiany.

## Zmiany w kodzie

| Plik | Zmiana |
| --- | --- |
| `app_front/App.js` | `.catch()` z `ensureAuthenticatedThenBoot()` deleguje do `resolveBootAfterAuthStatusFailure()`: offline + lokalny cache → `bootApp()`, inaczej nakładka. Bramka online w `.then` bez zmian. Seed z IDB odpala się tylko, gdy sync doc nie istnieje; gdy sync istnieje, ale nie zawiera żądanego `?chat=`, robi to fallback `forceIdb` w kontrolerze. |
| `app_front/features/chat/chatBootDecision.js` (nowy) | Czysty helper `resolveBootOnAuthStatusFailure({ online, hasLocalBootCache }) => 'boot' \| 'overlay'`. |
| `app_front/features/chat/chatOfflineBootSeed.js` (nowy) | Raw odczyt `cretli-chat-boot-cache-v1` z IDB (`cretli-chat-metadata`/`meta`, bez tworzenia DB) i odtworzenie `cretli-chat-boot-sync-v1`; `hasLocalBootCacheForOfflineBoot` / `seedLocalBootSyncFromIdbBootCache`. |
| `app_front/features/chat/chatLocalBootSync.js` | `hasLocalChatBootCacheForColdStart()`; `buildChatLocalBootSyncDoc()` dokłada `fullSignature` dopiero po przycięciu do budżetu i pomija go, gdy się nie mieści (naprawia zapis sync doc). `preferChatId` / `requiredChatIds` trzymają wiersz z `?chat=` w sync doc (≤40 wierszy). |
| `app_front/features/chat/chatLocalBootCache.js` | `isPartialBootCacheSubsetShrink` to teraz **tylko test kształtu** (bez progu 40). Skip zapisu jest bramkowany jawnym `isUnconfirmedBootCacheSource(input)` (`source === 'boot-cache'`); `source: 'server'` (lub brak) zawsze zapisuje, więc 41→40 usuwa ducha z IDB. `primeIncumbentBootCacheDoc()` dociąga incumbent z IDB przed decyzją, gdy mirror adaptera jest zimny. |
| `app_front/features/chat/chatController.js` | `chatBootCacheUnconfirmed` ustawiany po hydratacji z lokalnego snapshotu i zerowany po reconcile z serwerem; `collectChatListBootCacheInput()` dokłada `source`. Gałąź `preferChatId`/`forceIdb` odroczona o mikrotask (guard po bumpie `listRevision`), z `.catch` i bez nadpisywania czatu wybranego przez użytkownika. |
| `tests/chat-boot-offline-decision.test.js` | 26 testów: decyzja bootu, IDB seed, `fullSignature`, guard subset-shrink (w tym 41→40 ze `source: 'server'` i subset z `source: 'boot-cache'`), prymowanie zimnego mirrora, `preferChatId` w sync bootstrap oraz gałąź kontrolera `forceIdb` (jest w IDB → hydratacja + `selectChat`; brak → sensowny stan; brak nadpisania wyboru użytkownika). |
| `scripts/offline-boot-hydration-probe.mjs` | Tryb `CRETLI_PROBE_NON_ACTIVE=1` naprawdę ćwiczy żądany czat różny od aktywnego (rozgrzewka `?chat=<id>`, otwarcie innego czatu, offline reload na `<id>`). `SETTLE_MS` przed próbką offline i asercja liczby wierszy sidebara (online > 0 ⇒ offline > 0). `storageState` zwraca `chatIds` snapshotów. PASS wymaga `cards > 0`, `activeChat == <id>`, braku nakładki i braku kurczenia się IDB. |

Kontrakt Service Workera bez zmian: strefa `/api/*` nadal omija cache
(`public/sw.js`).

## Wynik — stan cache / SW (online)

- Service Worker: `count = 1`, `controller = true`, scope `https://127.0.0.1:3011/`.
- CacheStorage: `cretli-v27`, 28–30 wpisów (m.in. `/index.html`, `/offline.html`,
  `/dist/app/index.bundle.js`, ikony/PWA).
- IndexedDB: `cretli-chat-buffers`, `cretli-chat-metadata`, `cretli-preferences`,
  `cretli-push-inbox`, `cretli-sdk-chat` (osobna baza historii SDK — liczba wpisów zależy
  od otwartego czatu; harness nie używa jej jako kryterium PASS).
- localStorage: 54–57 kluczy `cretli*`; `cretli-chat-boot-sync-v1` ≈ 31–32 KB / 40 czatów;
  IDB `cretli-chat-boot-cache-v1` ≈ 91–92 KB / 139–140 czatów (online). **Po fixie offline
  IDB musi zachować ≥ tyle samo czatów i bajtów co online** (probe asercja).

## Wynik — offline reload

Zmierzone realnymi JSON-ami (`/api/chats` online działał w chwili tych przebiegów):

| Metryka | `fix-verify-active.json` (żądany == aktywny) | `fix3-nonactive-seed.json` (NON_ACTIVE + clear sync) |
| --- | --- | --- |
| `navigator.onLine` offline | `false` | `false` |
| Czas nawigacja → `cards > 0` | **364 ms** | **405 ms** |
| `cards` po hydratacji | **8** | **8** |
| `activeChat` offline | `fabd16a3-…` | `fabd16a3-…` (żądany) |
| `activeChat` online | `fabd16a3-…` | `b9021354-…` (inny — tryb NON_ACTIVE) |
| Nakładka „backend unavailable” | brak | brak |
| FCP | **30 ms** | **32 ms** |
| Wiersze sidebara online → offline | 47 → 1 (aktywny) | 48 → 1 (aktywny) |
| IDB `cretli-chat-boot-cache-v1` | online 140 / 92 010 B → offline **140 / 92 010 B** | online 140 / 91 764 B → offline **140 / 91 764 B** |
| `cretli-chat-boot-sync-v1` | 40 / 32 080 B | odtworzony po seed (`removed = 1`) |

### Dowód, że tryb NON_ACTIVE realnie działa

W `fix3-nonactive-seed.json` snapshot online ma `activeChatId = b9021354-…`, a żądany URL to
`?chat=fabd16a3-…`; po offline reloadzie `activeChat = fabd16a3-…` i `cards = 8`. Czyli
`preferChatId` wygrał z aktywnym czatem z cache. Ten sam przebieg z `CLEAR_SYNC` usuwa sync
doc (`removed = 1`), więc sync bootstrap powstaje z IDB + `preferChatId`.

### Wykryta i naprawiona regresja guardu (F1) — dowód z `fix3-active.json`

Przebieg `fix3-active.json` (przed ostatnią poprawką prymowania) ujawnił, że guard **nie
działał**, gdy mirror adaptera był zimny: `cards = 8` i `activeChat = fabd16a3-…`, ale
`online IDB = 139 czatów / 91 139 B` → `offline IDB = 40 czatów / 31 752 B` (shrink).
To dokładnie B1: `readIncumbentBootCacheDoc()` czytał `null`, więc wycinek 40 wierszy
nadpisał pełny snapshot. Po dodaniu `primeIncumbentBootCacheDoc()` i teście regresyjnym
`async boot persist primes a cold adapter mirror before the shrink guard` (26/26 zielonych)
guard pomija zapis, a `source: 'server'` nadal zapisuje 41→40 z usunięciem ducha.

## Requesty i console (offline)

- 59–64 zdarzenia sieciowe: 5–7 odpowiedzi `200` (zasoby powłoki z CacheStorage),
  22–26 `requestfailed`, wszystkie z `net::ERR_INTERNET_DISCONNECTED` w strefie `/api/*`
  (m.in. `/api/auth-status`, `/api/settings`, `/api/chats`, `/api/workspaces`,
  `/api/chats/<id>/history`). Spodziewane: SW celowo omija `/api/*`.
- Console: brak `pageerror` blokujących hydratację. Nieobsłużone odrzucenia
  `Failed to fetch` pochodzą z tła (`api.getWorkspaces()`, watcher) i nie blokują listy
  ani kart.
- Jedno oczekiwane ostrzeżenie `[chat] list load failed: Failed to fetch`
  (odrzucony `GET /api/chats` offline — listę i tak wypełnia boot cache).

## Wniosek

Po naprawie realny offline cold start `?chat=<id>` **hydratuje żądany czat**:
`cards = 8`, `activeChat = fabd16a3-…`, czas do hydratacji **~0,36–0,41 s** od startu
nawigacji, FCP 30–32 ms, sidebar nie jest pusty. Pełny snapshot IDB **nie kurczy się** po
offline reloadzie (140 czatów / ~92 KB), również gdy żądany czat różni się od aktywnego
i sync doc trzeba odtworzyć z IDB. Wymagane: (1) lokalny snapshot (sync lub IDB),
(2) żądanego czatu brak w sync ⇒ fallback `forceIdb` + `preferChatId`. Gdy cache
wyczyszczony — brak źródła, nakładka pozostaje. PASS w harnessie wymaga `cards > 0`,
`activeChat == <id>`, niepustego sidebara i stabilnego IDB.

## Ograniczenia

- Pomiar na `headless chromium` z `--no-sandbox`; wartości FCP/czasu mogą się
  różnić na innym sprzęcie.
- `navigator.onLine` jest heurystyczny; helper bootuje offline **tylko** przy
  `navigator.onLine === false` i niepustym lokalnym snapshocie. „Online, ale serwer
  nie odpowiada” nadal pokazuje nakładkę (zgodnie z wymaganiem).
- Naprawa `buildChatLocalBootSyncDoc` zatrzymuje bloat `fullSignature`, ale pole
  pozostaje w schemacie jako metadane; nie jest już nośnikiem pełnego podpisu.
- Nieobsłużone odrzucenia `getWorkspaces`/watchera offline zostają jako osobny,
  nieblokujący dług.
- **Blokada środowiskowa przy finalnej weryfikacji live:** po ostatniej poprawce
  prymowania serwer `https://127.0.0.1:3011` przestał odpowiadać na `GET /api/chats`
  (timeout > 30 s; `/api/health`, `/api/settings`, `/api/workspaces` odpowiadają).
  Równoległy proces nadpisał też `app_front/lib/sdk-rich-view.js` na 0 B (przywrócony z
  HEAD), a dev HMR serwował ~10 MB niekompilowany bundle. Finalny przebieg probe po
  poprawce prymowania nie mógł się dokonać w tym oknie; dowody live pochodzą z
  `fix-verify-active.json` (żądany == aktywny) i `fix3-nonactive-seed.json`
  (NON_ACTIVE + seed), a poprawka prymowania ma test regresyjny.
- Stan startowy (HEAD `79b8329` + brudne drzewo równoległych cykli) — pliki
  edytowane przez inne cykle nie były ruszane; zmieniano `App.js`, moduły bootu,
  `chatLocalBootCache.js`, `chatLocalBootSync.js`, `chatOfflineBootSeed.js`,
  `chatController.js`, harness, testy i ten dokument.

## Regresje

Uruchomione i zielone:

```bash
node tests/chat-local-boot-sync.test.js          # 11/11
node tests/chat-boot-offline-decision.test.js    # 26/26
node tests/chat-local-boot-cache.test.js         # OK
node tests/ui-freeze-counters.test.js            # OK
node tests/chat-history-hydration-live.test.js   # OK
node scripts/offline-boot-hydration-probe.mjs    # PASS: fix-verify-active.json
CRETLI_PROBE_NON_ACTIVE=1 CRETLI_CLEAR_SYNC_BEFORE_OFFLINE=1 \
  node scripts/offline-boot-hydration-probe.mjs  # PASS: fix3-nonactive-seed.json
```
