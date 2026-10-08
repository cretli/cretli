# Trwały rejestr recovery (store)

Fundament trwałości dla liści R2–R20: rejestr intencji uruchomień, prób i
przejść cyklu życia runu, singleton lease właściciela rejestru z fencingiem
generacji oraz trwała kolejka zatwierdzonych promptów, Stop i waiting (R4).
Źródłem prawdy w kodzie są
`lib/recovery/recovery-store.js` (store, CAS, migracja),
`lib/recovery/recovery-ids.js` (identyfikatory),
`lib/recovery/recovery-owner-lease.js` (lease owner/lease + fencing R3) oraz
`lib/recovery/recovery-queue.js` (kolejka/cancel/waiting R4 — pełny opis w
[docs/recovery-queue.md](./recovery-queue.md)). Słownik
recovery (stany, reason, decyzje, właściciele rodzin) pochodzi z kontraktu
opisanego w [docs/recovery-contract.md](./recovery-contract.md) — ten dokument go
nie duplikuje, tylko opisuje warstwę trwałości.

- `RECOVERY_STORE_SCHEMA_VERSION = 3` (wersja pliku SQLite)
- `RECOVERY_SCHEMA_VERSION = 1` (wersja rekordu JSON, z kontraktu)

Zakres: wyłącznie store, durability, migracja, CAS, wspólne ID oraz prymityw
owner/lease + fencing. Moduły **nie** podłączają się do runtime
(`chat-run-service.js`, `delegation-service.js`, `workspace-watcher*.js`, trasy) i
nie implementują polityki recovery — tę dostarczą późniejsze liście (R10 wspólny
owner recovery, R12 ręczny resume), opierając się na API opisanym niżej.

## Wybór backendu: SQLite WAL + `synchronous=FULL`

Store to SQLite przez wbudowane `node:sqlite` (`DatabaseSync`). Nie dodajemy
żadnej zależności z npm. Po otwarciu ustawiane są:

- `journal_mode = WAL` — czytelnicy nie blokują pisarza, a zapis jest
  przyrostowy; po SIGKILL/Crash OS odtwarza spójny stan z WAL.
- `busy_timeout` (domyślnie 8000 ms) — realna koordynacja wielu połączeń /
  procesów zamiast natychmiastowego `SQLITE_BUSY`.
- `foreign_keys = ON` — spójność referencyjna.
- `synchronous = FULL` — **kluczowe dla tego rejestru**. Intencja przed launch
  musi przeżyć crash procesu *i* systemu, a nie tylko procesu JS. `NORMAL` w
  WAL gwarantuje trwałość dopiero przy checkpoincie; `FULL` synkuje WAL przy
  każdym commicie.

### Dlaczego odrzucono JSON + fsync

Wariant „JSON + `writeJsonAtomic` + `fsync`” (wzorzec z
`lib/persist/atomic-write.js`) został odrzucony, ponieważ:

1. **Brak atomowego wielo-wierszowego CAS.** `writeRunIntent` musi w jednej
   operacji utworzyć logical run *i* pierwszy attempt; JSON to dwa pliki albo
   jeden plik przepisywany w całości — częściowy zapis pozostawia stan
   niespójny.
2. **Brak realnej konkurencji między procesami.** Ochrona JSON opiera się na
   zamkach plikowych/rename, bez transakcji i bez `BEGIN IMMEDIATE`; dwa
   procesy mogą wyścignąć się na „przeczytaj–zmień–zapisz”.
3. **Brak natywnego compare-and-swap.** `transitionRun` wymaga porównania
   `revision` i zapisu w jednej atomowej transakcji; w JSON trzeba by budować
   własny protokół blokad i odzyskiwania.

SQLite daje wszystkie trzy własności bez własnej implementacji.

## Schemat tabel

Każdy wiersz niesie kolumnę `json` z pełnym rekordem (ten sam wzorzec co
`delegations.sqlite`), a kolumny „indeksowe” służą do filtrowania i CAS.

`recovery_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)` — metadane, m.in.
`schemaVersion`. Uzupełnieniem jest `PRAGMA user_version`; migracja czyta i
zapisuje oba.

`recovery_runs` — logical run:

| kolumna | znaczenie |
| --- | --- |
| `logical_run_id` | PK, `lrun_<uuid>` |
| `family`, `owner` | rodzina i jej jedyny właściciel z `RUN_FAMILY_OWNERS` |
| `state` | stan cyklu życia (`RUN_LIFECYCLE_STATES`) |
| `workspace_folder`, `chat_id` | kontekst, po którym filtrują odczyty |
| `generation` | licznik generacji (fundament fencingu R3) |
| `revision` | monotoniczny licznik CAS |
| `request_id` | idempotencja intencji |
| `created_at`, `updated_at` | ISO |
| `json` | pełny rekord |

`recovery_attempts` — próba:

| kolumna | znaczenie |
| --- | --- |
| `attempt_id` | PK, `att_<uuid>` |
| `logical_run_id` | FK do `recovery_runs(logical_run_id)` (indeks `idx_recovery_attempts_run`) |
| `request_id` | idempotencja próby |
| `state`, `revision` | stan i rewizja próby |
| `created_at`, `updated_at`, `json` | jak wyżej |

`recovery_requests(request_id, kind, logical_run_id, attempt_id, created_at,
json, PRIMARY KEY(kind, request_id))` — trwały rejestr idempotencji; `kind` to
`run_intent` albo `attempt`, więc ten sam `requestId` w dwóch różnych rolach nie
koliduje. `logical_run_id` ma FK do `recovery_runs(logical_run_id)`.

`recovery_owner_lease(id INTEGER PRIMARY KEY CHECK (id = 1), owner_id,
owner_token, pid, pid_start, generation, started_at, heartbeat_at, json)` —
singleton lease właściciela rejestru (R3). `CHECK (id = 1)` wymusza dokładnie
jeden wiersz, więc „właściciel rejestru” jest jedna tożsamość, a nie zbiór
wierszy do skanowania.

| kolumna | znaczenie |
| --- | --- |
| `id` | zawsze `1` (singleton, `CHECK (id = 1)`) |
| `owner_id` | logiczna tożsamość właściciela (np. rola/serwis) |
| `owner_token` | serwerowy token fencingu (`randomUUID()`); jedyny dowód własności |
| `pid`, `pid_start` | PID właściciela i jego `/proc/<pid>` starttime (detekcja PID reuse) |
| `generation` | monotoniczny licznik generacji; rośnie o 1 przy każdym takeoverie |
| `started_at`, `heartbeat_at` | ISO; `heartbeat_at` + TTL wyznacza wygaśnięcie |
| `json` | pełny rekord lease (m.in. `ttlMs`) |

Ten wiersz nie ma FK do runów: lease jest per-rejestr, a nie per-run. Podobnie jak
reszta store’a trzyma metadane (id, token, pid, czasy) — bez treści promptów i
sekretów.

### Tabele v3 (R4): kolejka, cancel i waiting

`recovery_queue` — trwała kolejka zatwierdzonych promptów. W odróżnieniu od tabel
metadanych ta tabela **celowo przechowuje treść zatwierdzonego promptu** (kolumna
`payload`) albo jego referencję (`payload_ref`), bo od tego zależy kontrakt
persist-before-ACK (patrz [docs/recovery-queue.md](./recovery-queue.md)).

| kolumna | znaczenie |
| --- | --- |
| `queue_id` | PK; domyślnie równy `request_id`, może być zewnętrznym kluczem korelacji |
| `logical_run_id` | FK do `recovery_runs(logical_run_id)` |
| `attempt_id`, `request_id` | tożsamość i idempotencja (unikalny indeks cząstkowy po `request_id`) |
| `family`, `owner` | rodzina i właściciel (spójne z runem) |
| `state` | `queued` / `launched` / `waiting` / `cancelled` |
| `workspace_folder`, `chat_id` | kontekst filtrów |
| `harness`, `model`, `mode` | metadane wykonawcy |
| `payload`, `payload_ref` | zatwierdzony prompt albo referencja |
| `created_at`, `updated_at`, `json` | czasy i pełny rekord |

`recovery_cancels` — jedna trwała decyzja Stop na logical run
(`logical_run_id` PK, FK do runu). `request_id` wiąże ją z idempotencją
(`recovery_requests.kind = 'run_cancel'`), `reason` i `created_at` opisują
zgłoszenie. Run jest równolegle przenoszony CAS-em do stanu `cancelled`; ten
wiersz jest indeksowanym rejestrem cancelu.

`recovery_waiting` — jedno oczekujące pytanie/zgoda na run (`logical_run_id` PK,
FK do runu). `kind` to `question` albo `approval`, `state` to `pending` lub
`resolved`; `prompt_ref` i `answer` opisują odpowiednio pytanie i jawną odpowiedź
człowieka. Brak wiersza `pending` oznacza, że run nie czeka.

Tabele `recovery_attempts`, `recovery_requests`, `recovery_queue`,
`recovery_cancels` i `recovery_waiting` deklarują **realny**
`FOREIGN KEY (logical_run_id) REFERENCES recovery_runs(logical_run_id)`, a
połączenie działa z `PRAGMA foreign_keys = ON`. Dzięki temu wiersz próby,
wpisu idempotencji, kolejki, cancelu lub waiting nie może wskazywać
nieistniejącego runu; `PRAGMA foreign_key_check` na spójnym store jest pusty.
(FK egzekwuje SQLite, nie tylko warstwa JS, więc surowy zapis też jest
bezpieczny.)

Indeksy wymagane przez kontrakt: `idx_recovery_runs_family_state`
(`family, state`), `idx_recovery_runs_workspace` (`workspace_folder`),
`idx_recovery_attempts_run` (`logical_run_id`). Dodatkowo unikalne indeksy
cząstkowe po `request_id` w `recovery_runs`, `recovery_attempts` i
`recovery_queue` oraz indeksy `idx_recovery_queue_state_family`,
`idx_recovery_queue_state_workspace`, `idx_recovery_queue_run`,
`idx_recovery_waiting_state`, `idx_recovery_waiting_kind_state` obsługujące
listę/claim/filtry z `recovery-queue.js`.

Poza kolejką R4 store trzyma **tylko metadane**: identyfikatory, stany, ownera,
workspace, harness/model, `instanceToken`, czasy. Tabela `recovery_queue` jest
jedynym wyjątkiem i celowo przechowuje zatwierdzony prompt albo referencję, żeby
kolejka była użyteczna po crashu; transkrypt i sekrety nadal nie należą do store’u.

## Semantyka CAS i kody konfliktów

`transitionRun({ logicalRunId, expectedRevision, to, ... })` w jednej transakcji
`BEGIN IMMEDIATE`:

1. odczytuje run,
2. sprawdza `expectedRevision` oraz opcjonalne predykaty `expectedState`,
   `expectedOwner`, `expectedGeneration`,
3. waliduje krawędź przez `canTransitionRunLifecycle(from, to)`,
4. zapisuje nowy stan i `revision + 1`.

Konflikt logiczny **nie rzuca wyjątku** — zwraca
`{ ok:false, applied:false, conflict:true, reason, run }`:

| `reason` | znaczenie |
| --- | --- |
| `not_found` | brak runu o danym `logicalRunId` |
| `revision_conflict` | `revision` w store różni się od `expectedRevision` |
| `owner_mismatch` | `owner` runu ≠ `expectedOwner` |
| `generation_mismatch` | `generation` runu ≠ `expectedGeneration` |
| `state_mismatch` | stan runu ≠ `expectedState` |
| `illegal_transition` | krawędź niedozwolona przez kontrakt (albo nieznany stan docelowy) |

Sukces zwraca `{ ok:true, applied:true, conflict:false, reason:'applied', run }`.
Tylko błąd samego store (I/O, zamknięta baza) rzuca
`RecoveryStoreError('transition_failed')`. `revision` jest monotone.

`patch` przy tranzycji może dopiąć wyłącznie metadane (np. `sessionId`,
`harness`, `model`, `instanceToken`). **Chroniony zbiór** pól jest po
`Object.assign` przywracany z rekordu sprzed tranzycji i `patch` nigdy nie może
go zmienić:

`schemaVersion`, `logicalRunId`, `attemptId`, `requestId`, `family`, `owner`,
`state`, `revision`, `generation`, `createdAt`, `updatedAt`.

W szczególności `patch` **nie** może podmienić `generation` ani `requestId`
(fencing R3 ani idempotencja intencji nie mogą zostać sfałszowane przez
wołającego).

Predykaty `expectedOwner`/`expectedGeneration` są gotowe pod fencing R3; ten
liść nie podejmuje żadnej decyzji recovery.

### Realna konkurencja

Dwa niezależne otwarcia tego samego pliku (`openRecoveryStore` dwa razy) to dwie
osobne koneksje `DatabaseSync`. Test
`tests/recovery-store.test.js` uruchamia tę samą tranzycję z tym samym
`expectedRevision` na obu: dokładnie jedno zwraca `ok:true`, drugie
`revision_conflict`, a finalny `revision` rośnie o 1. To dowód, że CAS jest
atomowy między połączeniami, a nie tylko w obrębie jednego obiektu.

Test `tests/recovery-store-crash.test.js` idzie dalej i sprawdza CAS między
**osobnymi procesami OS**. `tests/helpers/recovery-crash-harness.js` udostępnia
`spawnRecoveryBarrier`: startuje dwa dziecięce `process.execPath` na tym samym
`recovery.sqlite`, każde otwiera store i wypisuje `READY`, a rodzic zwalnia
barierę dopiero, gdy oba są gotowe (tworzy plik `go`, na który dzieci czekają).
Dopiero wtedy oba wykonują `transitionRun` z tym samym `expectedRevision=1`.
Asercje: dokładnie jedno `ok:true`, dokładnie jedno `revision_conflict` i finalny
`revision = expected + 1` (=2). To dowód atomowości CAS w prawdziwym wyścigu
międzyprocesowym, a nie tylko sekwencyjnie.

## Lease właściciela i fencing generacji (R3)

`lib/recovery/recovery-owner-lease.js` to **trwały, międzyprocesowy lease
właściciela rejestru** plus token fencingu generacji. Każda mutacja działa na
singletonie `recovery_owner_lease` w jednej transakcji `BEGIN IMMEDIATE`, więc
dwa procesy na tym samym `recovery.sqlite` nie mogą jednocześnie zostać
właścicielem. Stała `RECOVERY_OWNER_LEASE_DEFAULT_TTL_MS = 30000`.

Żywotność PID i detekcja PID reuse są współdzielone z
`lib/delegation-owner-lock.js` (`isProcessAlive` — które samo używa
`isKillProbeAlive` — oraz `getProcessStartTime`); moduł nie czyta `/proc`
własnym kodem. Właściciel jest „żywy”, gdy PID istnieje, a jeśli zapisano
niepuste `pid_start`, to odczytany starttime jest identyczny. Nieczytelny
`/proc` nie jest dowodem śmierci.

### `acquireRecoveryOwnerLease({ dataDir?, store?, ownerId, ownerToken?, pid?, pidStart?, now?, ttlMs? })`

- `ownerId` jest wymagany (trim non-empty); inaczej rzuca
  `RecoveryOwnerLeaseError` z `code='invalid_owner'` — przed dotknięciem store’a.
- `ownerToken` domyślnie `randomUUID()` (generowany po stronie serwera),
  `pid` domyślnie `process.pid`, `pidStart` domyślnie z
  `getProcessStartTime(<pid>)`.
- W jednej transakcji:
  - brak wiersza → insert, `generation = 1`, `reason='created'`;
  - ten sam `ownerId` **i** `ownerToken` → odświeżenie `heartbeat_at`,
    `reason='renewed'`, generacja bez zmian;
  - właściciel martwy (PID nie żyje **albo** PID reuse) **lub** lease wygasł
    (`heartbeat_at + ttl <= now`) → takeover, `generation + 1`, nowy
    token/pid/pidStart, `reason='takeover'`;
  - żywy inny właściciel i niewygasły lease → `{ acquired:false,
    reason:'owner_held', lease }` — **bez wyjątku** (kolizja to wartość, nie błąd).
- Zwraca `{ acquired, renewed, takeover, reason, ownerToken, generation, lease }`.
  Przy `owner_held` `ownerToken` to token *kandydata*, nie token aktualnego
  właściciela; tylko `acquired:true` czyni token ważnym, więc naiwny wołający,
  który użyje wartości zwróconej przy `owner_held`, nie przejdzie fencingu.
- TTL zapisany w lease jest autorytatywny przy ocenie wygaśnięcia istniejącego
  wiersza: kandydat nie może przedłużyć cudzego lease’u, podając większe
  `ttlMs`. Parametr `ttlMs` ustawia TTL nowo zapisywanego lease’u.

### `checkRecoveryOwnerFence({ ownerToken, generation, ... })`

Zwraca `{ ok:true }` **tylko** gdy wiersz istnieje, token i generacja są zgodne
oraz lease jest żywy (właściciel żywy i heartbeat niewygasły). Inaczej
`{ ok:false, reason }` z `reason` w:

| `reason` | znaczenie |
| --- | --- |
| `no_lease` | brak wiersza |
| `stale_owner` | inny `ownerToken` (m.in. callback z przed takeoveru) |
| `generation_mismatch` | token zgodny, ale inna `generation` |
| `lease_expired` | `heartbeat_at + ttl <= now` |
| `owner_dead` | PID nie żyje albo wykryto PID reuse |

To jest odrzucanie starych callbacków: callback z przed takeoveru ma stary token
(albo starą generację) i dostaje `stale_owner` / `generation_mismatch`, a
callback po wygaśnięciu `lease_expired` / `owner_dead`.

### `renewRecoveryOwnerLease({ ownerToken, generation, ... })`

`{ ok:true, lease }` tylko gdy wiersz ma zgodny token **oraz** generację;
inaczej `{ ok:false, reason }` z `no_lease`, `stale_owner` albo
`generation_mismatch`. Odświeża wyłącznie `heartbeat_at`/TTL; generacji i
`started_at` nie zmienia.

### `getRecoveryOwnerLease({ ... })`

Bez mutacji: `{ held:false }` albo pełny opis
`{ held:true, ownerId, ownerToken, pid, pidStart, generation, startedAt,
heartbeatAt, expiresAt, expired, pidAlive, live }`. `expired` liczy się z
zapisanego TTL, `pidAlive` z istnienia PID, a `live = właściciel żywy (bez PID
reuse) && !expired`.

### `releaseRecoveryOwnerLease({ ownerToken, generation? })`

Usuwa singleton wyłącznie gdy token (i, gdy podano, generacja) się zgadzają.
Obcy/stary token **nie może** usunąć lease’u nowego właściciela ani go przejąć.
Zwraca `{ released:true|false, reason }`.

### `serverInstanceToken` nie jest lockiem

`serverInstanceToken` / `instanceToken` to diagnostyczna tożsamość instancji
serwera, a nie własność ani lock. Każda funkcja tego modułu ignoruje te pola:
przy żywym innym właścicielu `acquire` nadal zwraca `owner_held`, a zwrócony
lease nigdy nie traktuje `instanceToken` jako `ownerToken`. Dowodem własności i
podstawą fencingu jest wyłącznie serwerowy `ownerToken` + `generation` (a
`transitionRun` ma dodatkowo predykaty `expectedOwner`/`expectedGeneration`).

### Dowody międzyprocesowe

`tests/recovery-owner-lease.test.js` pokrywa m.in. `created`/`renewed`, drugiego
żywego właściciela (`owner_held`), takeover po martwym PID i po PID reuse, o
dokładnie TTL, odrzucanie starych callbacków, `renew`/`release` starym tokenem,
ignorowanie `instanceToken`, trwałość po zamknięciu/otwarciu store’a oraz
ochronę przed dwiema instancjami: dwa niezależne połączenia `openRecoveryStore`,
a także dwa procesy przez `spawnRecoveryBarrier` — dokładnie jedno wygrywa
takeover, drugie widzi `owner_held`, a `generation` rośnie dokładnie o 1.

## Schemat ID i zgodność z telemetrią

`lib/recovery/recovery-ids.js`:

- `RECOVERY_ID_KINDS = ['logical_run','attempt','request','cycle']`
- prefiksy: `lrun_`, `att_`, `req_`, `cyc_`
- `newRecoveryId(kind, { uuid })` — deterministyczne przy wstrzykniętym UUID;
  przy braku UUID generuje losowy v4. UUID jest walidowany (dowolna poprawna
  wersja), a błędny wstrzyknięty UUID rzuca `TypeError` — bez cichego fallbacku.
  Walidacja jest case-insensitive, wyjście kanonicznie małe litery.
- `parseRecoveryId(value)` → `{ kind, uuid }` albo `null`;
  `isRecoveryId(value, kind?)`.
- `createRecoveryIds({ uuid })` → cztery ID z jednego UUID (wspólny `uuid`,
  różne prefiksy).

**Kontrakt telemetrii:** `logicalRunId` i `attemptId` to dokładnie te wartości,
które później trafiają do telemetrii jako `runId` / `attemptId`
(`lib/usage/usage-event.js`, `lib/usage/usage-contract.js`). Format jest stabilnym
tokenem: bez spacji i znaków nowej linii, trymowany, krótszy niż limit 64 znaków
z `shortCode` i akceptowany przez `String(value ?? '').trim()` w
`buildLogicalUsageIdentity`. Modułów telemetrii nie modyfikujemy.

## Migracja i wersjonowanie (fail-closed)

`openRecoveryStore()` przed jakimkolwiek zapisem odczytuje wersję pliku
(`PRAGMA user_version` oraz `recovery_meta.schemaVersion`, bierze maksimum).
Jeśli wersja w pliku jest **większa** niż `RECOVERY_STORE_SCHEMA_VERSION`, store
rzuca `RecoveryStoreError` z `code='schema_too_new'` i nie dotyka danych
(fail-closed: starszy build nie może nadpisać nowszego pliku). W przeciwnym razie
`migrateRecoveryStore(store)` wykonuje DDL (`CREATE TABLE/INDEX IF NOT EXISTS`) i
zapisuje bieżącą wersję — operacja jest idempotentna i bezpieczna do wielokrotnego
wywołania.

Migracje `1 → 2` (R3) i `2 → 3` (R4) są **addytywne**: plik v1 dostaje tabelę
`recovery_owner_lease`, a plik v1/v2 dodatkowo `recovery_queue`,
`recovery_cancels` i `recovery_waiting` (`CREATE TABLE/INDEX IF NOT EXISTS`), a
semantyka `writeRunIntent`/`transitionRun`/CAS nie zmienia się. Świeży plik od
razu powstaje w wersji 3; plik v3 przy ponownym otwarciu przechodzi DDL jako
no-op. Ponieważ DDL zawiera wyłącznie `IF NOT EXISTS`, migracja jest idempotentna
i nie wymaga osobnego kroku wersjonowania per tabela.

Fail-closed obejmuje też plik nieczytelny. `probeSchemaVersion` zwraca 0
**tylko** dla braku pliku albo pliku o rozmiarze 0. Istniejący, niepusty plik,
którego nie da się odczytać jako SQLite (śmieci, obcy format, błąd uprawnień),
powoduje `RecoveryStoreError('store_open_failed')` zamiast potraktowania go jak
świeży store — nadpisanie takiego pliku zniszczyłoby dane. Probe otwiera plik
tylko do odczytu (`readOnly`), więc jego bajty pozostają nietknięte. Ogólny błąd
otwarcia/DDL również daje `code='store_open_failed'`.

## Kontrakt: błąd zapisu intencji blokuje launch

`writeRunIntent(input)` to **krytyczny zapis przed uruchomieniem wykonawcy**. W
jednej transakcji `BEGIN IMMEDIATE` tworzy logical run w stanie `starting` i
pierwszy attempt. Wymagane: `logicalRunId` (`lrun_<uuid>`), `attemptId`
(`att_<uuid>`), `family` (z `RUN_FAMILY_OWNERS`), `owner`, `requestId`
(`req_<uuid>`); opcjonalne: `workspaceFolder`, `chatId`, `sessionId`, `harness`,
`model`, `instanceToken`, `generation`, `now`.

- Zły input (zły format ID — w tym `requestId` niepasujący do
  `isRecoveryId(requestId, 'request')`, nieznana rodzina, owner niezgodny z
  rodziną) → `RecoveryStoreError('invalid_intent')`.
- Powtórzenie z tym samym `requestId` i **tą samą** tożsamością
  (`logicalRunId` *i* `attemptId`) → `{ created:false, run, attempt }` i brak
  duplikatu runu (idempotencja).
- Ten sam `requestId` z **innym** `logicalRunId` albo `attemptId` →
  `RecoveryStoreError('request_conflict')`. To nie jest cicha idempotencja:
  wołający dowiedziałby się, że intencja istnieje, choć wskazywałaby inny run.
  Ten sam kod zwraca `registerAttempt` (kind `attempt`) dla konfliktu
  `requestId`.
- **Każdy błąd zapisu** (I/O, constraint, zamknięta baza, brak otwartego store) →
  `RecoveryStoreError('intent_write_failed')`.

`request_conflict` jest rzucane przed jakimkolwiek wstawieniem — store pozostaje
nietknięty. `registerAttempt` waliduje `requestId` (gdy podany) i analogicznie
rzuca `RecoveryStoreError('attempt_write_failed')` dla złego formatu.

Ten ostatni kod jest sygnałem **„zablokuj launch”**: wołający, który nie potrafi
utrwalić intencji, nie może wystartować wykonawcy. Inaczej crash w oknie między
startem a zapisem zostawiłby run bez śladu w rejestrze, którego nie da się
odróżnić od runu nigdy nieuruchomionego. Analogicznie `registerAttempt` przy
błędzie rzuca `RecoveryStoreError('attempt_write_failed')`.

## Harness crash-testów

`tests/helpers/recovery-crash-harness.js` uruchamia **dziecięcy**
`process.execPath` z własnym tymczasowym dataDir i własnym `recovery.sqlite`
(przekazywanym w `RECOVERY_CRASH_DATA_DIR` / `RECOVERY_CRASH_STORE_PATH`).
Dziecko wykonuje dowolny skrypt ESM, wypisuje znacznik gotowości (domyślnie
`READY`) i czeka; rodzic zabija je realnym `process.kill(pid, 'SIGKILL')`, a
następnie otwiera store ponownie. Harness jest reużywalny (parametryzowany
skryptem i/lub `dataDir`) i sprząta po sobie (`dispose()`).

Harness eksportuje także `spawnRecoveryBarrier({ script, dataDir, count,
envForIndex })`: startuje `count` dzieci na **wspólnym** `recovery.sqlite`, czeka
aż każde wypisze `READY`, a `release()` tworzy plik `go`, na który dzieci
czekają. Ścieżka `go` trafia do dziecka w `RECOVERY_CRASH_BARRIER`. To bariera do
testowania prawdziwego wyścigu międzyprocesowego (CAS), a nie tylko crashu.

Testy w `tests/recovery-store-crash.test.js`:

1. dziecko zapisuje intencję, sygnalizuje gotowość, rodzic SIGKILL → po
   ponownym otwarciu run i attempt są obecne (dowód `synchronous=FULL` +
   WAL), a powtórzenie intencji nadal jest idempotentne.
2. dziecko otwiera `BEGIN IMMEDIATE` i wstawia wiersz bez `COMMIT`, po czym
   zawiesza się; po SIGKILL store przechodzi `PRAGMA integrity_check` i **nie ma**
   częściowego wiersza, a kolejny zapis nadal działa.
3. dwa procesy ruszają z bariery (`READY` ×2 → `go`) i wykonują ten sam CAS;
   dokładnie jedno `ok:true`, jedno `revision_conflict`, finalny
   `revision = expected + 1`.

Testy 1–2 pomijają się z czytelnym komunikatem tylko na platformach bez SIGKILL
(`supportsSigkill()`); na Linuksie działają realnie. Test 3 (bariera) nie wymaga
SIGKILL.

## Znane ograniczenia

- Store jest jednohostowy (jeden plik, WAL); to nie jest store
  rozproszony/wieloregionowy. Dotyczy to także lease’u właściciela: fencing
  działa między procesami na jednym pliku `recovery.sqlite`, nie między hostami.
- Polityka recovery (kiedy `reattach`, `resume_session`, `new_attempt`, kiedy
  przejąć owner lease) należy do kolejnych liści. R3 dostarcza wyłącznie
  prymityw owner/lease + fencing (i dowody), ale sam nie decyduje, kiedy go
  użyć, i nie podłącza się do runtime.
- `transitionRun` dotyczy cyklu życia *runu*; cykl życia *próby* nie ma
  jeszcze własnej tranzycji CAS (świadomie poza zakresem R2).
- `json` przechowuje rekord w całości; `patch` przy tranzycji może dopiąć
  dowolne metadane **poza** chronionym zbiorem pól tożsamości/cyklu życia, więc
  wołający nie może wkładać tam treści promptów ani sekretów (wyjątkiem jest
  zatwierdzony prompt w dedykowanej kolumnie `recovery_queue.payload` z R4).
- Funkcje lease przyjmują otwarty `store` **albo** `dataDir`. Wariant `dataDir`
  otwiera i zamyka prywatne połączenie przez `openRecoveryStore`, które ustawia
  store jako domyślny procesu — wołający, który polega na procesowym domyślnym
  store, powinni przekazywać jawny uchwyt `store`.
- `lib/recovery/recovery-queue.js` (R4) to wciąż prymityw store’u: nie podłącza
  się do runtime, nie decyduje, kiedy uruchomić kolejkę, i nie odpowiada
  automatycznie na pytania/zgody. Ograniczenia kolejki opisuje
  [docs/recovery-queue.md](./recovery-queue.md).
