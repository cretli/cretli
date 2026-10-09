# Kontrakt recovery

Wersjonowany, maszynowy kontrakt recovery dla Cretli. Źródłem prawdy w kodzie
jest `lib/recovery/recovery-contract.js`; ten dokument opisuje ten sam kontrakt
w języku polskim (nazwy stałych pozostają angielskie). Dokument i moduł muszą
być zmieniane razem.

- `RECOVERY_SCHEMA_VERSION = 1`
- `RECOVERY_CONTRACT_REVISION = '2026-10-08.2'`

## Zakres i granica

Kontrakt definiuje wspólny słownik dla liści R2–R20: stany runu i dozwolone
przejścia, trwałe reason przerwania, decyzje recovery, właściciela każdej
rodziny runów, rozdzielenie wyniku infrastruktury od raportu agenta, reguły
księgowania failures/backoff/budżetu/cycleCount oraz listę adapterów MVP.

Granica: moduł **tylko opisuje i wylicza**. Nie podłącza się do runtime i nie
zmienia `chat-run-service.js`, `delegation-service.js`, `workspace-watcher*.js`
ani żadnej trasy. Wszystkie funkcje są deterministyczne; `now` jest wstrzykiwane
przez wołającego, więc wynik nie zależy od zegara ani od stanu zewnętrznego.

Dwie twarde zasady, których nie wolno obejść w kolejnych liściach:

1. **Serwer ustala `infraOutcome` i cykl życia runu.** Raport agenta (outcome i
   verdict) nigdy ich nie nadpisuje.
2. **Nie automatycznie nie-żywego runu.** `reattach` jest jedyną decyzją
   automatyczną i tylko dla `liveness === 'alive'` z adapterem wspierającym
   reattach.

## Macierz stanów + tabela przejść

Stany (`RUN_LIFECYCLE_STATES`, dokładnie 8):

| Stan | Klasyfikacja |
| --- | --- |
| `starting` | aktywny (`RUN_ACTIVE_STATES`) |
| `running` | aktywny (`RUN_ACTIVE_STATES`) |
| `waiting` | aktywny (`RUN_ACTIVE_STATES`) |
| `completed` | terminalny (`RUN_TERMINAL_STATES`) |
| `cancelled` | terminalny (`RUN_TERMINAL_STATES`) |
| `interrupted` | terminalny dla próby i zarazem recoverable (`RUN_TERMINAL_STATES`, `RUN_RECOVERABLE_STATES`) |
| `unknown` | nieokreślony (`RUN_INDETERMINATE_STATES`) i recoverable (`RUN_RECOVERABLE_STATES`) |
| `recovering` | nieokreślony (`RUN_INDETERMINATE_STATES`) |

- `RUN_RECOVERABLE_STATES = ['interrupted','unknown']`
- `normalizeRunLifecycleState(value)` zwraca stan albo `''` dla wartości
  nieznanej (także pustej).
- `canTransitionRunLifecycle(from, to)` sprawdza krawędź; self-transition jest
  zawsze dozwolone, a `completed` i `cancelled` są finalne (poza self).

Tabela przejść (`tak` = dozwolone; self-transition pominięto w komórkach i
opisano jako zawsze dozwolone):

| from \ to | starting | running | waiting | completed | cancelled | interrupted | unknown | recovering |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `''` (brak runu) | tak | - | - | - | - | - | - | - |
| `starting` | self | tak | tak | tak | tak | tak | tak | - |
| `running` | - | self | tak | tak | tak | tak | tak | - |
| `waiting` | - | tak | self | tak | tak | tak | tak | - |
| `completed` | - | - | - | self | - | - | - | - |
| `cancelled` | - | - | - | - | self | - | - | - |
| `interrupted` | - | - | - | tak | tak | self | - | tak |
| `unknown` | - | - | - | tak | tak | - | self | tak |
| `recovering` | tak | tak | tak | tak | tak | tak | tak | self |

Uwagi:

- `completed` i `cancelled` nie mogą wrócić do stanu aktywnego
  (`completed -> running` jest zabronione).
- `interrupted -> recovering` oraz `unknown -> recovering` są dozwolone; dopiero
  `recovering` może wystartować nową próbę.
- `unknown -> starting` jest zabronione — najpierw trzeba potwierdzić przerwanie
  i wejść w `recovering`.

## Reason i decyzje recovery

Reason przerwania (`RUN_INTERRUPT_REASONS`):

| Reason | Znaczenie |
| --- | --- |
| `server_restart` | restart serwera; pochodzi z `DELEGATION_INTERRUPT_CODES` |
| `starting_timeout` | run nie wystartował w oknie startowym; z `DELEGATION_INTERRUPT_CODES` |
| `running_orphan` | osierocony działający run; z `DELEGATION_INTERRUPT_CODES` |
| `process_gone` | proces zabity z zewnątrz (SIGKILL / OOM) |
| `unknown` | nieustalona przyczyna; konserwatywny fallback |

Trzy pierwsze kody są importowane z `lib/delegation-status.js`
(`DELEGATION_INTERRUPT_CODES`), więc nie mogą się rozjechać. `process_gone` i
`unknown` są dodatkami kontraktu recovery. `normalizeRunInterruptReason(value)`
zwraca znany reason albo `'unknown'`.

Decyzje (`RUN_RECOVERY_DECISIONS`): `reattach`, `resume_session`, `new_attempt`,
`manual_only`, `unsupported`, `not_recoverable`.

Dozwolone decyzje per reason (`RUN_RECOVERY_DECISION_BY_REASON`):

| Reason | Dozwolone decyzje |
| --- | --- |
| `server_restart` | `reattach`, `resume_session`, `new_attempt`, `manual_only` |
| `starting_timeout` | `resume_session`, `new_attempt`, `manual_only` |
| `running_orphan` | `reattach`, `resume_session`, `new_attempt`, `manual_only` |
| `process_gone` | `resume_session`, `new_attempt`, `manual_only` |
| `unknown` | `not_recoverable` |

`resolveRecoveryDecision({ reason, adapter, liveness })` stosuje deterministyczny
priorytet:

1. brak/nieobsługiwany adapter → `unsupported`, `automatic: false`,
2. reason bez ścieżki recovery (np. `unknown`) → `not_recoverable`,
3. `liveness === 'alive'`, `adapter.reattach === true` **oraz** `reattach` jest na
   liście dozwolonych decyzji dla danego reason → `reattach`, `automatic: true`,
4. `liveness !== 'alive'`, adapter ma `resumeStrategy` **oraz** `resume_session`
   jest dozwolony dla reason → `resume_session` (`automatic: false`),
5. w pozostałych przypadkach → `manual_only` (`automatic: false`), o ile jest
   dozwolony dla reason.

Mapa `RUN_RECOVERY_DECISION_BY_REASON` jest autorytatywna: resolver nie zwraca
decyzji spoza listy przypisanej do reason (wyjątki: `unsupported`,
`not_recoverable`).

Wynik ma kształt
`{ decision, reason, adapter, liveness, automatic, rationale }`, gdzie
`adapter` to identyfikator harnessu (`''`, gdy brak). `new_attempt` bywa legalną
decyzją w mapie reason, ale resolver sam jej nie wybiera — należy do wyższej
warstwy polityki (R14). `liveness` przyjmuje `alive`, `dead`, `unknown`
(nieznana wartość normalizuje się do `unknown`).

## Owner rodzin runów

`RUN_FAMILY_OWNERS` mapuje rodzinę runów na dokładnie jednego właściciela
serwerowego. Recovery nie duplikuje logiki claimów/kolejek właściciela — pyta
właściciela.

| Rodzina | Owner | Moduł | Cel |
| --- | --- | --- | --- |
| `chat` | `chat-run-service` | `lib/chat-run-service.js` | start/cancel/probe zwykłego runu czatu i blokada per czat |
| `delegation` | `delegation-service` | `lib/delegation-service.js` | cykl życia delegacji, slot rodzica, jednorazowa kontynuacja |
| `watcher` | `workspace-watcher` | `lib/workspace-watcher.js` | cykle, lease, failures i backoff workspace |
| `mailbox` | `delegation-mailbox` | `lib/delegation-mailbox.js` | dostarczanie raportów i wiadomości do rodzica |
| `workflow` | `delegation-workflow` | `lib/delegation-workflow.js` | stan pętli plan/implement/review/fix i budżet |
| `scout` | `workspace-watcher-scout` | `lib/workspace-watcher-scout.js` | skanowanie workspace i propozycje findings |

- `ownerOfRunFamily(family)` zwraca wpis albo `null`.
- `assertSingleRunFamilyOwner()` weryfikuje, że każda rodzina ma dokładnie jeden
  wpis z niepustym `owner` i że żaden owner nie obsługuje dwóch rodzin; zwraca
  `true`, a przy naruszeniu rzuca błąd.

## Infra outcome vs raport agenta

To najważniejsze rozdzielenie kontraktu.

- `RUN_INFRA_OUTCOMES` (ustala wyłącznie serwer): `none`, `accepted`,
  `completed`, `cancelled`, `interrupted`, `unsupported`, `unknown`.
- `RUN_AGENT_OUTCOMES` (raport agenta): `unspecified`, `success`, `failure`,
  `blocked` — zgodne z `DELEGATION_TASK_OUTCOMES`.
- `RUN_AGENT_VERDICTS`: `unspecified`, `PASS`, `FAIL`, `BLOCKED`, `conflict`.

`resolveRunOutcome({ infraOutcome, agentOutcome, agentVerdict })` zwraca
`{ outcomeSource: 'server', infraOutcome, agentOutcome, agentVerdict, accepted,
countsAsFailure, terminal, rationale }` i stosuje reguły:

1. `accepted` tylko gdy `infraOutcome === 'completed'` **oraz** `agentVerdict`
   nie jest `FAIL`/`BLOCKED`/`conflict` **oraz** `agentOutcome` nie jest
   `failure`/`blocked`.
2. Raport agenta nigdy nie zmienia `infraOutcome` ani lifecycle; sam `PASS` nie
   ratuje runu `interrupted`/`unknown`/`cancelled`.
3. `interrupted`, `unsupported`, `unknown` → `accepted: false`,
   `countsAsFailure: true` (nawet przy `PASS`).
4. `conflict` → `accepted: false`.
5. `cancelled` jest terminalne, ale nie jest failure.
6. `countsAsFailure` opisuje wyłącznie licznik infrastruktury. Agentowy
   `failure`/`blocked` przy `completed` blokuje akceptację, ale **nie**
   zwiększa licznika failures (patrz niżej).

`terminal` jest prawdziwe tylko dla `completed`, `cancelled`, `interrupted`.

## Reguły księgowania

`RECOVERY_ACCOUNTING_RULES` to maszynowy opis; `nextRecoveryAccounting` to
deterministyczny reducer (przyjmuje `previous`, `event.kind` oraz `now`).

Rodzaje zdarzeń (`RECOVERY_EVENT_KINDS`): `cycle_start`, `cycle_success`,
`infra_failure`, `interrupted`, `agent_failure`, `user_cancel`.

- **failures** — rosną tylko przy `infra_failure` i `interrupted`. Reset przy
  `cycle_success`. `agent_failure`, `user_cancel` i `cycle_start` nie zmieniają
  licznika.
- **backoff** — `computeRecoveryBackoffMs({ failures })`:
  `min(baseMs * 2^(failures-1), capMs)` dla `failures > 0`, w przeciwnym razie
  `0`. Domyślnie `baseMs = 30000` (`RECOVERY_BACKOFF_BASE_MS`), a
  `capMs = 3600000` (`RECOVERY_BACKOFF_CAP_MS`). Backoff jest ustawiany przy
  `infra_failure`/`interrupted` jako `backoffUntil = now + backoff`, zerowany
  przy `cycle_success` i `user_cancel`.
- **budget** — `budgetUsed` zawsze równa się `cyclesStarted`. Infra-failure
  **nie** zwraca budżetu; `budgetRefunded` pozostaje `false` (żadne zdarzenie w
  MVP nie robi refundu).
- **cycleCount** — `cycle_start` zwiększa jednocześnie `cyclesStarted` i
  `cycleCount`; failures pozostają bez zmian.
- **cycleStart** — `cycle_start`: `cyclesStarted+1`, `cycleCount+1`, failures
  bez zmian.
- **agentReport** — `agent_failure`: brak wpływu na failures/backoff/budget;
  zapisywany jest tylko `lastEventKind`.

`nextRecoveryAccounting` zwraca
`{ failures, consecutiveFailures, backoffUntil, cyclesStarted, cycleCount,
budgetUsed, budgetRefunded, lastEventKind }`. `now` jest wstrzykiwane, więc
`backoffUntil` jest liczbą (epoch ms) albo `null`. Nieznane zdarzenie jest
ignorowane i zachowuje poprzedni `lastEventKind`.

## Adaptery MVP

`RECOVERY_MVP_ADAPTERS` — sześć rodzin z pełnym kontraktem recovery w MVP:

| Harness | `resumeStrategy` | `reattach` |
| --- | --- | --- |
| `sdk` | `agent_resume` | nie |
| `claude` | `session_resume` | nie |
| `codex` | `resume_thread` | nie |
| `qwen` | `session_resume` | nie |
| `deepseek` | `session_id` | nie |
| `opencode` | `server_reattach` | tak |

Każdy wpis ma `requiresCrashValidation: true`, `validation: 'pending'` i
`scope: 'mvp'`. Oznacza to, że auto-recovery nie może być włączone, dopóki
liść R19 (live SIGKILL) nie przejdzie testu awarii dla konkretnego harnessu i
wersji SDK. Liść R7 buduje macierz walidacji adaptera (`adapterValidation`).
`describeRecoveryAdapterContract` zwraca tylko zadeklarowany stan
(`validation: 'pending'`, `requiresCrashValidation: true`) oraz statyczne
scenariusze `context` i `live_executor`. Scenariusze `waiting`, `cancel` i
`missing_transcript` zostają `pending` (`notRun`), dopóki jawne
`evaluateRecoveryAdapterValidation({ harness, store })` nie policzy ich na
wstrzykniętym store (albo `{ openEphemeralStore: true }` w narzędziach).
`buildRecoveryAdapterValidationRecord` tylko składa te pola i nie robi I/O.
Widok kontraktu nie otwiera SQLite. Macierz sama nie zastępuje crash suite.
Tylko `opencode` potrafi `reattach` do żywego wykonawcy; pozostałe po śmierci
procesu wznawiają zachowaną sesję.

Poza MVP (`RECOVERY_DEFERRED_ADAPTERS`): `codebuddy`, `openrouter` i `mistral`, z
uzasadnieniem w `RECOVERY_DEFERRED_ADAPTER_REASONS`:

- `codebuddy` — runner po utracie procesu tworzy świeżą live session bez
  wznowienia zapisanego ID; pełny tool recovery wymaga osobnej pracy.
- `openrouter` — odtwarza tylko tekst user/assistant, bez pełnej pętli
  tool-call/tool-result; nie kwalifikuje się do auto-resume.
- `mistral` — jak `openrouter`: odtwarza tylko tekst user/assistant, bez pełnej
  pętli tool-call/tool-result hosta; nie kwalifikuje się do auto-resume.

`resolveRecoveryAdapter(harness)` zwraca wpis MVP albo
`{ supported: false, harness, scope: 'unsupported' }` dla nieznanego harnessu.

## Kontrakt adaptera w runtime i jawna utrata transcriptu

`describeRecoveryAdapterContract(harness)` to pojedyncze miejsce, którego używa
runtime (liść R6: `lib/chat-run-service.js#getChatRunAdapterCapabilities`,
`lib/chat-run/kernel-adapter.js`), żeby nie duplikować tabeli zdolności. Zwraca
pola statycznego wpisu MVP plus sygnały, które adapter musi wystawić:
`supported`, `scope`, `deferred`, `reattach`, `resumeStrategy`,
`requiresCrashValidation`, `validation`, `transcriptLost`,
`transcriptLossReason`, `adapterValidation` (macierz R7: klucz
`{harness}@{sdkVersion}`, status ogólny `pending` do R19; widok kontraktu nie
uruchamia scenariuszy store — `waiting` / `cancel` / `missing_transcript` są
`pending`, aż `evaluateRecoveryAdapterValidation` dostanie jawny store), a dla
transportu bez kontraktu — `decision: 'unsupported'` i `infraOutcome:
'unsupported'` (te same tokeny co `RUN_RECOVERY_DECISIONS` i
`RUN_INFRA_OUTCOMES`; `unsupported` nie jest definiowane ponownie).

Transport poza MVP (`codebuddy`, `openrouter`, `mistral`) albo nieznany nigdy nie jest
zwracany jako ciche `false`, które wołający mógłby odczytać jako „run się
skończył”. Dostaje jawny `unsupported`.

Zasada „jawna obsługa utraty kontekstu, zaginionych sesji” (sekcja 3 planu) jest
sygnałem metadanych, nie decyzją. Tokeny `RUN_TRANSCRIPT_LOSS_REASONS`:

| Token | Znaczenie |
| --- | --- |
| `none` | ten sam żywy kontekst wykonawcy trwa dalej (reattach) |
| `room_missing` | zaobserwowane: room trzymający transcript zniknął (restart procesu) |
| `no_live_run_match` | zaobserwowane: room istnieje, ale nie trzyma żywego runu zgodnego z trwałym `adapterRunId` |
| `fresh_turn_in_saved_session` | wznowienie zaczyna nową turę w zapisanym ID sesji, nie w połowie transcriptu |
| `no_recovery_contract` | transport w ogóle nie zadeklarował kontraktu recovery |

Statycznie: tylko `opencode` (`server_reattach`, `reattach: true`) daje
`transcriptLost: false`; każda inna strategia MVP to nowa tura w zapisanej
sesji, więc `transcriptLost: true` z tokenem `fresh_turn_in_saved_session`;
transport bez kontraktu dostaje `no_recovery_contract`. W lookupie po
`requestId` dochodzą dwa sygnały zaobserwowane: `room_missing` (roomu już nie ma)
oraz `no_live_run_match` (room jest, ale nie trzyma żywego runu zgodnego z trwałym
`adapterRunId` — brak `currentRun` albo inny `id`). Żaden z tych tokenów
nie odblokowuje wznowienia — decyzję nadal liczy `resolveRecoveryDecision`, a
brama `accepted` pozostaje w R5.

## Wersjonowanie

- `RECOVERY_SCHEMA_VERSION` — podbijany, gdy trwały kształt rekordu recovery
  zyska/zmieni pole. Obecnie `1`.
- `RECOVERY_CONTRACT_REVISION` — czytelna wersja macierzy/dokumentu. Obecnie
  `2026-10-08.2`.

Każda zmiana wartości w `lib/recovery/recovery-contract.js` wymaga:

1. podbicia odpowiedniej wersji (schema i/lub revision),
2. aktualizacji tego dokumentu tak, aby pozostał zgodny z modułem,
3. utrzymania zielonego `tests/recovery-contract.test.js`, który m.in. sprawdza
   obecność revision i wszystkich stanów w tym dokumencie.
