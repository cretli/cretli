# Cykl życia startu i zakończenia runu (R5)

`lib/recovery/recovery-lifecycle.js` to warstwa cyklu życia zbudowana na
prymitywach liści R2–R4: rejestrze (`recovery-store.js`), lease właściciela
(`recovery-owner-lease.js`), kolejce/Stopie/waitingu (`recovery-queue.js`) i
słowniku (`recovery-contract.js`). Odpowiada na trzy pytania, których każdy
późniejszy liść recovery potrzebuje jako trwałego, pojedynczego źródła prawdy:

1. **Intencja przed wysłaniem promptu** — `beginRunLaunch` zapisuje intencję
   startu (a gdy input niesie zatwierdzony prompt, trwale go kolejkuje)
   **zanim** wołający dostanie pozwolenie na wystartowanie wykonawcy. Błąd
   trwałości to sygnał blokady: rzuca `RecoveryLifecycleError('launch_blocked')`
   i wołający **nie może** wtedy startować wykonawcy. `mayStart:true` zwracane
   jest wyłącznie na ścieżce pełnej trwałości.
2. **Acceptance wymaga dowodu** — run osiąga `accepted` tylko przez
   `recordExecutorAck`, który wymaga `source` od wykonawcy i robi CAS
   `starting → running`. Bez trwałego ACK wykonawcy stan to `unconfirmed`
   (`markAcceptanceUnconfirmed`), nigdy cicho `accepted`.
3. **Terminalny stan wymaga dowodu** — `finishRun` zapisuje stan terminalny
   dopiero, gdy wołający podał `proof`; bez niego stan terminalny nie jest
   zapisywany wcale (`terminal_proof_required`).

Bramką liścia jest `canAutoRelaunch`: **bez dowodu `accepted` żadne automatyczne
ponowne wysłanie nie jest dozwolone**, niezależnie od tego, co zdecydowałby
adapter. Przejść bramkę może tylko decyzja sama w sobie `automatic` (w praktyce
`reattach` przy żywym wykonawcy i adapterze zdolnym do reattach).

Powiązanie z historią i telemetrią jest wyłącznie metadane:
`attachHistoryRef` zapisuje trwały referencję `{ chatId, seq }` przez `patch`
CAS-u runu, a `buildUsageIdentity` to czysta funkcja mapująca, której wynik jest
bezpośrednio zjadalny przez
`lib/usage/usage-contract.js#buildLogicalUsageIdentity` (`durableSequence`).
Wzorem `recovery-ids.js` moduł **nie importuje i nie modyfikuje** modułów
telemetrii; powiązanie dowodzi się w testach, nie przez import.

## Zakres i granica

Jak reszta `lib/recovery/**` to jest warstwa **store-only**: brak timerów, brak
`setInterval`, brak `process.env`, brak importów runtime (`chat-run-service.js`,
`room-kernel.js`, `lib/agent-harness/*`, `delegation-*`, `workspace-watcher*`,
trasy, `server.js`) i brak polityki recovery, resume ani reconciliation.
**Liść nie podłącza się do live runtime.** Rejestrację tych prymitywów w
`startChatRun`, w reconciliation i w resume niosą liście **R6/R8/R10/R12**; sama
polityka recovery to **R14**.

**Trwałość:** bez nowych tabel SQLite i bez bumpowania
`RECOVERY_STORE_SCHEMA_VERSION` (wciąż 3). Acceptance, terminal proof i
referencja historii zapisywane są na JSON-ie runu przez `transitionRun(...,
patch)`. `RECOVERY_LIFECYCLE_SCHEMA_VERSION = 1` wersjonuje wyłącznie te
pod-obiekty cyklu życia, nie rekord bazowego store’u.

Stałe:

- `RECOVERY_LIFECYCLE_SCHEMA_VERSION = 1`,
- `RUN_ACCEPTANCE_STATES = ['accepted', 'unconfirmed']`,
- `RUN_ACCEPTANCE_SOURCES = ['adapter_ack', 'lookup_request', 'manual']`,
- `RUN_TERMINAL_PROOF_SOURCES = ['agent_report', 'adapter_event', 'probe_idle',
  'user_cancel', 'manual']`.

## `beginRunLaunch` — intencja przed startem

```js
beginRunLaunch(input, store?) -> { created, ids, run, attempt, queueEntry, mayStart, launchToken }
```

Wymagane: `family` (klucz z `RUN_FAMILY_OWNERS`), `owner` (zgodny z rodziną —
walidowane przez `ownerOfRunFamily`; nieznana rodzina albo owner niezgodny z
rodziną → `invalid_launch_input`). Identyfikatory opcjonalne: `logicalRunId`,
`attemptId`, `requestId`, `cycleId` — jeśli nie podane, mintowane przez
`createRecoveryIds()`; jeśli podane, walidowane `isRecoveryId(..., kind)`.
Metadane opcjonalne: `chatId`, `workspaceFolder`, `harness`, `model`,
`sessionId`, `instanceToken`, `generation`, `mode`, `now`. Opcjonalny zatwierdzony
prompt: `prompt` albo `promptRef`.

Kolejność: walidacja rodziny/właściciela i id → `writeRunIntent` (stan
`starting` + pierwszy attempt) → jeśli input niesie prompt, `enqueueApprovedPrompt`
PRZED zwrotem tokenu. Każdy błąd zapisu intencji albo kolejki → `launch_blocked`.

**Kontrakt dla wołającego:** tylko nie-rzucający zwrot jest punktem, w którym
start wykonawcy jest dozwolony. `RecoveryLifecycleError('launch_blocked')`
znaczy: nie startuj. `mayStart` jest zawsze `true` na ścieżce sukcesu — przy
braku trwałości rzucamy, więc częściowy start nie istnieje.

Idempotencja na `requestId`: replay tego samego `requestId` z tą samą tożsamością
→ `created:false` i JEDEN wiersz runu; ten sam `requestId` z INNA tożsamością →
`launch_blocked` z `details.cause = 'request_conflict'` (bez cichego wskazania
obcego runu).

Zwracany `launchToken` to `{ logicalRunId, attemptId, requestId, state,
createdAt }` — wyłącznie metadane, **nigdy treść promptu**. Uwaga: bazowy store
metadane intencji trzyma w JSON-ie runu, a tryb `mode` store podstawowy zapisuje
tylko we wpisie kolejki (zapis `mode` przez `writeRunIntent` jest ignorowany) —
pełne podłączenie do runtime to R6.

## `recordExecutorAck` — accepted tylko z dowodem

```js
recordExecutorAck({ logicalRunId, expectedRevision, source, adapterRunId?, now? }, store?)
  -> { applied, conflict, reason, run, acceptance }
```

CAS `starting → running` z `infraOutcome:'accepted'`, `expectedState:'starting'`
i `patch.acceptance = { state:'accepted', source, adapterRunId, ackedAt }`.
`source` musi być w `RUN_ACCEPTANCE_SOURCES` (brak/obcy →
`invalid_acceptance_input`).

- run już z `acceptance.state === 'accepted'` → `{ applied:false,
  reason:'already_accepted' }` BEZ zapisu (`revision` nie rośnie),
- run terminalny **nie może** zostać zaakceptowany → konflikt
  (`reason:'illegal_transition'`) bez próby tranzycji,
- konflikt CAS (`revision_conflict`/`state_mismatch`) jest ZWRACANY
  (`conflict:true`), nie rzucany; tylko realny błąd store’u →
  `acceptance_write_failed`.

## `markAcceptanceUnconfirmed` — jawne „brak dowodu”

```js
markAcceptanceUnconfirmed({ logicalRunId, expectedRevision, reasonToken, now? }, store?)
  -> { applied, conflict, reason, run, acceptance }
```

Zapisuje `patch.acceptance = { state:'unconfirmed', reason, markedAt }` przez
**self-transition** (`to` = aktualny stan), więc run NIE zmienia stanu (zostaje
`starting`) — nie kłamie, że `running`. `reasonToken` musi być niepusty (inaczej
`invalid_acceptance_input`). Ten stan odcina bramkę `canAutoRelaunch`: jedyną
wartością acceptance, która ją przechodzi, jest `accepted`.

## `finishRun` — terminalny dowód

```js
finishRun({ logicalRunId, expectedRevision, to, proof, infraOutcome, reason?, agentOutcome?, agentVerdict?, now? }, store?)
  -> { applied, conflict, reason, run, outcome }
```

- `to` MUSI być wartością z `RUN_TERMINAL_STATES`; nie-terminalny `to` →
  `invalid_terminal_input`,
- `proof` MUSI mieć `source` z `RUN_TERMINAL_PROOF_SOURCES`; brak `proof` albo
  pusty/obcy `proof.source` → `terminal_proof_required` i ŻADEN zapis stanu
  terminalnego. **To jest rdzeń liścia.**
- serwer decyduje o `infraOutcome` (wymagany, normalizowany
  `normalizeRunInfraOutcome`, nadpisywany przez nic); `agentOutcome`/`agentVerdict`
  to tylko metadane karmiące `resolveRunOutcome`, które nigdy nie pozwala
  raportowi agenta nadpisać prawdy serwera,
- `reason` trafia do CAS-a TYLKO dla `to:'interrupted'` z podanym reasonem; dla
  `completed`/`cancelled` nic nie jest wstrzykiwane (bez fałszywego `'unknown'`),
- run już terminalny z TYM SAMYM `to` → `{ applied:false,
  reason:'already_terminal' }` bez drugiego zapisu; z INNYM `to` → konflikt
  (`illegal_transition`) bez mutacji — cykl życia jest finalny dla
  „finishowania”, nawet gdy bazowa macierz dopuszczałaby np. `interrupted →
  completed`,
- konflikt CAS zwracany, nie rzucany; błąd store’u → `terminal_write_failed`.

Zapisywany `patch.terminalProof = { source, detail, adapterRunId, state: to,
recordedAt }`.

## `canAutoRelaunch` — bezwzględna bramka liścia

```js
canAutoRelaunch({ logicalRunId, liveness?, harness? }, store?)
  -> { allowed, reason, decision?, rationale }
```

Reguły w TEJ kolejności; każda odrzucona ścieżka zwraca `{ allowed:false, reason,
... }` (bez rzucania):

| # | warunek | `reason` |
| --- | --- | --- |
| 1 | brak runu | `run_missing` |
| 2 | `acceptance.state !== 'accepted'` (brak ALBO `unconfirmed`) | `no_acceptance_proof` — GŁÓWNA reguła, wygrywa z decyzją adaptera |
| 3 | run `cancelled` (stan) ALBO trwały cancel (`isRunCancelled`) | `cancelled` |
| 4 | run `waiting` (stan) ALBO pending waiting (`getRunWaiting`) | `waiting` |
| 5 | run w `RUN_ACTIVE_STATES` (`starting`/`running`) | `still_active` |
| 6 | run `completed` | `already_completed` |
| 7 | run `interrupted`/`unknown` | delegacja do `resolveRecoveryDecision`; `allowed:true` WYŁĄCZNIE gdy `decision.automatic === true` (praktycznie `reattach` przy `liveness:'alive'` i adjektywie z `reattach`), inaczej `manual_only` z `decision` |

`liveness`/`harness` służą WYŁĄCZNIE odgałęzieniu decyzji w regule 7 i nie mogą
unieważnić reguły 2. Złe wejście (pusty `logicalRunId`) → `invalid_gate_input`;
store nieczytelny → `store_unavailable`.

## Powiązanie z historią i telemetrią

```js
attachHistoryRef({ logicalRunId, expectedRevision, history: { chatId, seq }, now? }, store?)
  -> { applied, conflict, reason, run, history }
```

Self-transition bez zmiany stanu, zapisuje `patch.history = { chatId, seq,
attachedAt }`. `seq` musi być liczbą całkowitą > 0, a `chatId` niepusty; inaczej
kod walidacyjny `invalid_terminal_input` (spójny z resztą liścia — ten sam kod
walidacji wejścia, brak mnożenia kodów). Konflikt CAS zwracany; store
niezapisywalny → `store_unavailable`.

```js
buildUsageIdentity({ logicalRunId, attemptId, sessionId, requestId, harness }) -> {
  durableSequence: true, runId, attemptId, sourceSessionId, requestId, harness
}
```

Czysta funkcja (zero I/O). Mapuje `logicalRunId → runId`, `attemptId →
attemptId`, `sessionId → sourceSessionId`, `requestId → requestId` oraz
`harness`. **Nie skraca i nie przekształca id** (nagłówek R2 gwarantuje, że id są
pojedynczymi przyciętymi tokenami akceptowanymi przez normalizatory telemetrii
bez zmian). Wynik przekazany do `buildLogicalUsageIdentity` daje
`identityClass === 'durable_sequence'` — co dowodzą testy.

## Kody błędów

Wszystkie błędy to `RecoveryLifecycleError` z `.code` i `.details`
(`isRecoveryLifecycleError`). Konflikty logiczne są ZWRACANE jako wartości, nie
rzucane.

| `code` | kiedy |
| --- | --- |
| `invalid_launch_input` | zła rodzina/właściciel/id w `beginRunLaunch` |
| `launch_blocked` | błąd zapisu intencji ALBO kolejki w `beginRunLaunch` (block-ACK, `details.cause` = kod store’u/kolejki) |
| `invalid_acceptance_input` | brak/zły `source`, `logicalRunId` albo `reasonToken` w `recordExecutorAck`/`markAcceptanceUnconfirmed` |
| `acceptance_write_failed` | realny błąd store’u przy zapisie acceptance |
| `invalid_terminal_input` | zły `logicalRunId`/`expectedRevision`/`to`/`infraOutcome` w `finishRun`; zły `history.seq`/`chatId` w `attachHistoryRef` |
| `terminal_proof_required` | brak `proof` albo pusty/obcy `proof.source` w `finishRun` |
| `terminal_write_failed` | realny błąd store’u przy terminalnej tranzycji |
| `invalid_gate_input` | pusty `logicalRunId` w `canAutoRelaunch` |
| `store_unavailable` | store nieczytelny/niezapisywalny w `canAutoRelaunch` i `attachHistoryRef` (brak bardziej swoistego kodu zapisu) |

Idempotencja `beginRunLaunch` i kolejki opiera się na wspólnym rejestrze
`recovery_requests`: `run_intent` i `queue_enqueue` to różne `kind`, więc ten sam
`requestId` w obu rolach nie koliduje, ale użycie `requestId` w roli `queue_enqueue`
dla innej tożsamości daje twardy `request_conflict` (przemapowany na
`launch_blocked`).

## Dowody testów

`tests/recovery-lifecycle.test.js` (node:test, własny tymczasowy `dataDir`)
pokrywa m.in.: `beginRunLaunch` tworzący run `starting` + attempt z replay-idempotencją
i jednym wierszem; `invalid_launch_input` dla złej rodziny/właściciela/id;
zablokowany launch przy zamkniętym store z brakiem wpisu i runu; durably
zakolejkowany prompt i odizolowaną blokadę na gałęzi kolejki (`request_conflict`);
konflikt obcego `requestId` jako `launch_blocked`; `recordExecutorAck` z dowodem
→ `running`/`accepted` + idempotencję bez wzrostu `revision`; odmowę brak/obcy
`source` oraz odmowę „zaakceptowania” runu terminalnego; `markAcceptanceUnconfirmed`
zostawiający `starting` i odcinający bramkę; rdzeń: `canAutoRelaunch` bez ACK →
`no_acceptance_proof`, nawet dla żywego adaptera `opencode`; werdykty bramki po
stanie (`cancelled`, `waiting`, `still_active`, `manual_only`/`resume_session`,
`allowed:true`/`reattach`, `not_recoverable`, `run_missing`); `finishRun` bez
`proof` (`terminal_proof_required`, brak mutacji), `completed`/`FAIL`/`interrupted`
(server > agent, `countsAsFailure`), brak wstrzykiwania `'unknown'` oraz
`already_terminal`/konflikt na runie terminalnym; CAS `revision_conflict` dla
wszystkich mutatorów bez mutacji; walidację i trwałość `attachHistoryRef` przez
restart; `buildUsageIdentity` → `durable_sequence` z asercją ≤64 znaków/braku
białych znaków i czystości; trwałość acceptance i terminal proof po
reopen z tym samym werdyktem bramki.

`tests/recovery-lifecycle-crash.test.js` używa
`tests/helpers/recovery-crash-harness.js` i realnego `SIGKILL`: dziecko robi
`beginRunLaunch` z promptem i sygnalizuje `READY`, rodzic zabija je PRZED
jakimkolwiek ACK; po ponownym otwarciu run jest `starting`, `acceptance` jest
nieobecne, prompt w kolejce trwa, a `canAutoRelaunch` → `no_acceptance_proof`.
Przypadek pomija się z czytelnym komunikatem tylko na platformach bez SIGKILL
(`supportsSigkill()`); na Linuksie działa realnie.

## Znane ograniczenia

- **Brak podłączenia do runtime.** Moduł nie startuje wykonawcy, nie rejestruje
  runu w `startChatRun` i nie wywołuje reconciliation/resume. Robią to liście
  R6/R8/R10/R12.
- `beginRunLaunch` z zatwierdzonym promptem, którego zapis kolejki zawiedzie,
  ZOSTAWIA już zcommitowany wiersz runu `starting` (intencja to osobna
  transakcja niż kolejka). To celowe: sygnał `launch_blocked` zakazuje startu, a
  osierocony run `starting` domknie reconciliation (R8). Nie udajemy częściowego
  startu wykonawcy.
- `mode` w `beginRunLaunch` jest trwale zapisywane tylko we wpisie kolejki; bazowy
  store (`writeRunIntent`) ignoruje `mode` na runie. Wynosi to poza zakres R5.
- `attachHistoryRef` korzysta z kodu walidacyjnego `invalid_terminal_input` i
  kodu błędu store’u `store_unavailable` zamiast własnych, by nie mnożyć kodów
  (patrz tabela).
- Acceptance/terminal proof/history trzymane są w JSON-ie runu przez `patch`
  CAS-a; chronione pola tożsamości/cyklu życia są zawsze przywracane sprzediego
  stanu w `transitionRun`, więc `patch` nie przesunie runu na inną tożsamość.
