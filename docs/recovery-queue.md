# Trwała kolejka, Stop i waiting (R4)

`lib/recovery/recovery-queue.js` to prymityw store’u dla trzech obietnic
widocznych dla użytkownika:

1. **Persist-before-ACK** — zatwierdzony prompt jest zapisany, zanim wołający
   potwierdzi zatwierdzenie.
2. **Cancel-before-ACK** — Stop jest trwały, zanim wołający potwierdzi
   zatrzymanie; crash po ACK nie może wskrzesić runu.
3. **Waiting bez auto-odpowiedzi** — run wchodzi w `waiting` wyłącznie przez
   `markRunWaiting` (pytanie/zgoda) i wychodzi wyłącznie przez jawną odpowiedź
   człowieka w `resolveRunWaiting`.

Moduł korzysta z rejestru recovery opisanego w
[docs/recovery-store.md](./recovery-store.md) i ze słownika z
[docs/recovery-contract.md](./recovery-contract.md). Zakres jest **store-only**:
moduł nie podłącza się do runtime (`chat-run-service.js`,
`delegation-service.js`, `workspace-watcher*.js`, trasy) i nie implementuje
polityki recovery — to zadanie późniejszych liści (m.in. R5, R10, R12).

Stałe:

- `RECOVERY_QUEUE_SCHEMA_VERSION = 1` (wersja rekordu JSON),
- `RECOVERY_STORE_SCHEMA_VERSION = 3` (wersja pliku SQLite; tabele v3),
- stany wpisu: `queued`, `launched`, `waiting`, `cancelled`,
- rodzaje waiting: `question`, `approval`.

Tabele v3 (`recovery_queue`, `recovery_cancels`, `recovery_waiting`) i ich
kolumny opisuje [docs/recovery-store.md](./recovery-store.md). Ten dokument
opisuje semantykę API i kody błędów.

## Persist-before-ACK: `enqueueApprovedPrompt`

```js
enqueueApprovedPrompt(input, store?) -> { created, entry }
```

Wymagane: `logicalRunId` (`lrun_<uuid>`), `attemptId` (`att_<uuid>`), `requestId`
(`req_<uuid>`), `family` (z `RUN_FAMILY_OWNERS`), `owner` (zgodny z rodziną).
Opcjonalne: `queueId` (domyślnie `requestId`), `chatId`, `workspaceFolder`,
`harness`, `model`, `mode`, `prompt`, `promptRef`, `now`.

W jednej transakcji `BEGIN IMMEDIATE` moduł:

1. sprawdza, czy `requestId` już istnieje w `recovery_requests`
   (`kind = 'queue_enqueue'`),
2. sprawdza, że logical run istnieje i ma zgodną rodzinę/właściciela,
3. wstawia wiersz `recovery_queue` (wraz z `payload`/`payload_ref`) i wpis
   idempotencji.

Funkcja wraca **dopiero po `COMMIT`**. To jest sygnał block-ACK: wołający może
powiedzieć użytkownikowi „zatwierdzone” wyłącznie po udanym powrocie. Każdy błąd
zapisu (I/O, zamknięta baza, `PRAGMA query_only`) rzuca
`RecoveryQueueError('queue_write_failed')` i **nie wolno** wtedy potwierdzać
zatwierdzenia.

Semantyka:

- ten sam `requestId` i ta sama tożsamość (`logicalRunId` + `attemptId`) →
  `{ created:false, entry }`, bez duplikatu wiersza;
- ten sam `requestId` i inna tożsamość → `request_conflict` (twardy konflikt, nie
  cicha idempotencja — wołający wskazywałby inny run);
- zły input (zły format ID, nieznana rodzina, owner niezgodny z rodziną, pusty
  `queueId`) → `invalid_queue_input`;
- nieistniejący run → `invalid_queue_input` z `details.cause = 'run_not_found'`.

`queueId` domyślnie równa się `requestId`, więc wpis ma stabilny klucz
korelacji; jawny `queueId` pozwala podpiąć zewnętrzny klucz.

## Claim: `claimNextQueuedEntry`

```js
claimNextQueuedEntry({ family?, workspaceFolder?, now? }, store?) -> { entry } | null
```

W jednej transakcji `BEGIN IMMEDIATE` wybiera najstarszy wpis w stanie `queued`,
którego run **nie jest** w `waiting` ani `cancelled`, i CAS-em przenosi go do
`launched`. Dzięki temu:

- dwa niezależne połączenia `openRecoveryStore` (albo dwa procesy) rozstrzygają
  claim dokładnie na jednego zwycięzcę,
- wpis `waiting`/`cancelled` ani run `waiting`/`cancelled` nigdy nie zostanie
  zajęty (także w oknie crashu, gdy run jest już `cancelled`, a wpis jeszcze
  `queued`),
- filtr `family`/`workspaceFolder` zawęża wybór.

Brak kandydata zwraca `null` (to nie jest błąd).

`getQueueEntry(queueId)` i `listQueueEntries({ family?, state?, workspaceFolder?,
chatId?, logicalRunId?, limit? })` to odczyty (bez mutacji).

## Cancel-before-ACK: Stop

```js
requestRunCancel({ logicalRunId, requestId, reason?, now? }, store?)
  -> { cancelled, alreadyCancelled, run, entries, cancel }
```

`requestRunCancel`:

1. sprawdza idempotencję po `requestId` (`recovery_requests.kind = 'run_cancel'`),
2. przenosi run do stanu `cancelled` przez CAS `transitionRun`, tolerując run już
   `cancelled`; przy `revision_conflict`/`state_mismatch` ponawia CAS (Stop musi
   wygrać wyścig, a nie po cichu przegrać),
3. w jednej transakcji zapisuje wiersz `recovery_cancels`, wpis idempotencji i
   przenosi wszystkie nieterminalne wpisy kolejki (`queued`, `waiting`,
   `launched`) do `cancelled`.

Powrót następuje po `COMMIT`, więc crash tuż po powrocie nie może wskrzesić
runu. Każdy błąd zapisu rzuca `RecoveryQueueError('cancel_write_failed')`
(block-ACK).

- ten sam `requestId` i ten sam run → `{ cancelled:false, alreadyCancelled:true }`;
- ten sam `requestId` i inny run → `request_conflict`;
- run już `cancelled` → `cancelled:false`, `alreadyCancelled:true`;
- run `completed` (terminalny, nie da się przenieść do `cancelled`) →
  `cancelled:false`, `alreadyCancelled:false` — i tak nie ma czego wskrzeszać;
- brak runu → `invalid_cancel_input` z `details.cause = 'run_not_found'`.

Odczyt: `isRunCancelled(logicalRunId)` (prawda, gdy run ma stan `cancelled`
**albo** istnieje wiersz cancelu), `getRunCancel(logicalRunId)` (wiersz cancelu;
gdy go brak, ale run jest `cancelled`, rekord jest syntezowany z metadanych runu —
odporność na crash między CAS-em a zapisem rejestru) oraz
`listCancelledRuns({ family?, workspaceFolder?, limit? })`.

### Cancel podczas crashu

Kolejność zapisów jest tak dobrana, że autorytatywny jest stan runu: CAS
`cancelled` commituje się przed zapisem znormalizowanego rejestru. Crash w oknie
między nimi zostawia run `cancelled` (czyli `isRunCancelled` = prawda i
`resolveQueueEntryAction` = `skip`), a brakujący rejestr jest odtwarzalny przy
kolejnej próbie. Znormalizowane zapisy są idempotentne, więc replay nie tworzy
duplikatów.

## Waiting bez auto-odpowiedzi

```js
markRunWaiting({ logicalRunId, expectedRevision, kind, requestId, promptRef?, now? })
  -> { ok, applied, conflict, reason, run }
```

`kind` musi być `question` albo `approval`; inaczej
`RecoveryQueueError('invalid_waiting_input')`. To **jedyny** powód wejścia runu w
`waiting`:

1. CAS `transitionRun` z `expectedRevision` wołającego przenosi run do `waiting`;
   konflikt (`revision_conflict`, `state_mismatch`, `illegal_transition`) jest
   wartością, nie wyjątkiem (`{ ok:false, conflict:true, reason, run }`),
2. po udanej tranzycji zapisywany jest wiersz `recovery_waiting` (stan `pending`)
   oraz wpis `recovery_requests.kind = 'run_waiting'`. Wpisy kolejki w stanie
   `launched` są parkowane jako `waiting`; wpisy `queued` **nie** są parkowane
   (run w `waiting` i tak blokuje claim), żeby po `resolveRunWaiting` nadal
   dało się je zająć przez `claimNextQueuedEntry`.

Replay tego samego `requestId` jest idempotentny (`applied:false`,
`reason:'already_waiting'`); ten sam `requestId` dla innego runu to
`request_conflict`.

```js
resolveRunWaiting({ logicalRunId, expectedRevision, requestId, answer?, now? })
  -> { ok, applied, conflict, reason, run }
```

To **jawna odpowiedź człowieka**: CAS przenosi run `waiting → running`, wiersz
waiting przechodzi w stan `resolved` z `answer` (pending input wyczyszczony), a
wpisy kolejki wcześniej zaparkowane (`waiting` po `launched`) wracają do
`launched`. Wpisy, które cały czas były `queued`, pozostają `queued` i mogą
zostać zajęte po wznowieniu runu. Replay jest idempotentny
(`already_resolved`); run już `running` również zwraca `already_resolved`, a run
w innym stanie zwraca `{ ok:false, conflict:true, reason:'not_waiting' }`.

Odczyt: `getRunWaiting(logicalRunId)` (tylko `pending`; gdy brak wiersza
`recovery_waiting`, ale run ma stan `waiting` i metadane
`waitingRequestId`/`waitingKind`, rekord jest **syntezowany** z runu — ta sama
gwarancja odkrywalności co `getRunCancel` przy crashu między CAS-em a zapisem
rejestru),
`listWaitingRuns({ family?, workspaceFolder?, chatId?, kind?, limit? })`
(listuje runy w stanie `waiting`, z wierszem rejestru lub syntezą; dołączony
`family`, `owner` i `runState`).

### Decyzja `resolveQueueEntryAction(entry, run?)`

Czysta, deterministyczna funkcja (bez I/O), która mówi, co wolno zrobić z
wpisem:

| warunek | `action` | `automatic` |
| --- | --- | --- |
| wpis `cancelled` **albo** run `cancelled` | `skip` | `false` |
| run `waiting` **albo** wpis `waiting` | `manual_only` | `false` |
| wpis `queued` i istniejący run nie-`waiting`/nie-`cancelled` | `launch` | `true` |
| brak wpisu/runu, wpis `launched` albo inny stan | `skip` | `false` |

Reguła „waiting → `manual_only`, `automatic:false`” jest twarda: żadna
automatyczna polityka nie może odpowiedzieć na pytanie/zgodę ani wznowić runu,
który czeka.

## Kody błędów i idempotencja

Wszystkie błędy to `RecoveryQueueError` z polem `.code` i `.details`
(`isRecoveryQueueError`).

| `code` | kiedy |
| --- | --- |
| `invalid_queue_input` | zły input/nieistniejący run w `enqueueApprovedPrompt` |
| `queue_write_failed` | błąd trwałego zapisu kolejki (block-ACK) |
| `queue_claim_failed` | błąd store’u podczas claimu |
| `invalid_cancel_input` | zły input/nieistniejący run w `requestRunCancel` |
| `cancel_write_failed` | błąd trwałego zapisu cancelu (block-ACK) |
| `invalid_waiting_input` | zły input/`kind` w `markRunWaiting`/`resolveRunWaiting` |
| `waiting_write_failed` | błąd trwałego zapisu waiting |
| `request_conflict` | ten sam `requestId` dla innej tożsamości |
| `store_unavailable` | odczyt bez otwartego store’u |

Idempotencja korzysta ze wspólnego rejestru `recovery_requests` z rodzajami
`queue_enqueue`, `run_cancel`, `run_waiting`, `run_waiting_resolve`. Klucz to
`(kind, request_id)`, więc ten sam `requestId` w różnych rolach nie koliduje, ale
ponowne użycie w tej samej roli dla innej tożsamości daje `request_conflict`.

## Dowody crash-testów

`tests/recovery-queue.test.js` pokrywa m.in. idempotencję i konflikt
`requestId`, `invalid_queue_input`, błąd zapisu bez częściowego wiersza, wyścig
claimu dwóch połączeń, pierwszeństwo Stopu nad wpisem `queued`, przejścia
waiting/resolve, brak auto-startu dla waiting oraz trwałość po
zamknięciu/otwarciu store’u i klucze obce.

`tests/recovery-queue-crash.test.js` używa
`tests/helpers/recovery-crash-harness.js` i realnego `SIGKILL`:

1. dziecko kolejkuje zatwierdzony prompt, sygnalizuje `READY`, rodzic zabija je
   `SIGKILL`; po ponownym otwarciu wpis istnieje, a `payload` jest
   bajt-identyczny (i replay enqueue jest idempotentny),
2. dziecko wykonuje `requestRunCancel` i dopiero potem wypisuje `READY`
   (kill następuje po powrocie funkcji); po ponownym otwarciu run i wpis są
   `cancelled`, a `resolveQueueEntryAction` zwraca `skip`/`automatic:false` — brak
   wskrzeszenia,
3. dziecko wprowadza run w `waiting`, `SIGKILL`, po ponownym otwarciu waiting
   nadal jest `pending`, claim zwraca `null`, a decyzja to
   `manual_only`/`automatic:false`.

Przypadki 1–3 pomijają się z czytelnym komunikatem tylko na platformach bez
SIGKILL (`supportsSigkill()`); na Linuksie działają realnie.

## Znane ograniczenia

- Jeden host i jeden plik `recovery.sqlite` (WAL). Claim, cancel i waiting są
  atomowe między procesami na tym pliku, ale nie między hostami.
- Brak podłączenia do runtime: moduł nie startuje claimu, nie wysyła promptu do
  wykonawcy i nie wywołuje `resolveRunWaiting` samoczynnie. To robią dopiero
  liście R5/R10/R12.
- `requestRunCancel` jest „best-effort spójny”: autorytatywny jest CAS stanu runu
  + `patch` na runie, a znormalizowany rejestr `recovery_cancels` może zostać
  odtworzony przy replayu. Dzięki temu Stop nigdy nie „przegrywa” z crashu, ale
  lista canceli może chwilowo korzystać z syntezy z metadanych runu.
- Model `waiting` zakłada jedną oczekującą pozycję na run (`logical_run_id` jest
  PK w `recovery_waiting`); równoległe pytania w jednym runie wymagają
  rozszerzenia klucza w późniejszym liściu.
- `recovery_queue.payload` celowo przechowuje treść zatwierdzonego promptu; przy
  dużych promptach zapis jest kosztowny, a referencja (`promptRef`) pozostaje
  alternatywą.
- Kolejka nie ma własnej, niezależnej od runu tranzycji cyklu życia wpisu poza
  CAS-em `queued → launched`; zakończenie runu nie zamyka wpisu (świadomie poza
  zakresem R4).
