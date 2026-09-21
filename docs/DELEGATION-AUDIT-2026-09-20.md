# Audyt delegacji Cretli — 2026-09-20

## Zakres i wynik

Ocena bieżącego drzewa roboczego, w tym istniejących niezacommitowanych zmian. Analiza kodu, 32 pliki testowe delegacji/katalogu/MCP oraz rzeczywista delegacja audytu przez `delegation_start`. Użyty skill: `.cursor/skills/cretli-multi-harness/SKILL.md`. Zakres zadania użytkownika to audyt i plan, nie wdrożenie poprawek.

Wniosek: solidne fundamenty trwałości i kontroli pojedynczego zadania, ale gwarancje review, kontrakt orkiestracji i obserwowalność wymagają dopracowania przed szerszą automatyzacją. Zielone testy nie dowodzą poprawności wszystkich rzeczywistych adapterów.

## Mocne strony

- **Kontrola startu:** blokada per parent, idempotency key z hashem parametrów, kontrola źródła przez revision/hash oraz zakaz zagnieżdżonych delegacji. `lib/delegation-service.js`, `lib/delegation-source.js`, `lib/delegation-executor.js`.
- **Kontrola prób i zatrzymania:** attempt/run fencing i zachowanie zajętego slotu do potwierdzenia zatrzymania ograniczają spóźnione raporty i nakładanie uruchomień. `lib/delegation-mailbox.js`, `lib/delegation-status.js`, `lib/delegation-service.js`.
- **Trwałe dostarczanie:** outbox, mailbox, recovery i backoff; rozdzielenie zakończenia wykonania, wyniku zadania i zatwierdzenia raportu. `lib/delegation-runtime-worker.js`, `lib/delegation-mailbox.js`.
- **Przemyślany magazyn single-host:** owner lock, opcjonalny SQLite, weryfikowana migracja i rollback. `docs/DELEGATION-STORE.md`, `lib/persist/delegation-migrate.js`.
- **Ograniczony fanout:** domyślnie jedno dziecko, opcjonalnie dwa review; implement/fix wykluczają inne zadania tego parenta. Wspólna polityka start/retry i testy konfliktów. `lib/delegation-width.js`, `tests/delegation-review-fanout.test.js`.
- **Dobór modelu:** `model_pick` filtruje enabled/ready/can_delegate, uwzględnia role, preferencje i wykluczenie bazowego identyfikatora modelu. `lib/model-role-profiles.js`.

## Problemy i ograniczenia

### P1 — review nie wszędzie gwarantuje blokadę przed zapisem

`lib/codex/codex-thread-options.js:20` ustawia `danger-full-access`. `lib/codex/codex-agent-ws.js:110` sprawdza znormalizowane zdarzenia narzędzi i dopiero wtedy przerywa turę. To wykrywanie i przerwanie, nie dowód odmowy przed wykonaniem. Jednocześnie `lib/delegation-adapter-capabilities.js:98` zwraca `deniesMutation: true` dla każdego review. Deklaracja jest silniejsza niż wykazana gwarancja.

Test `tests/delegation-phase3-adapter-guards.test.js` sprawdza wspólny guard i wspólny tool executor; sam oznacza live coverage jako `deferred-no-paid-models`. Nie dowodzi zatrzymania natywnego zapisu przez proces Codexa. Potwierdzono konstrukcję kodu i lukę w dowodach; nie wykonywano próby nieautoryzowanego zapisu na żywym workspace. DeepSeek review jest certyfikowany przez `sandboxReadOnly` i patch DSH read-only (etap 2); live E2E zapisu nadal `deferred`.

### P1 — niepełny kontrakt wyniku dla parenta

`lib/mcp/builtin/delegation-tools.js:12` pomija `taskOutcome`, `runStopping` i `slotOccupied` w podsumowaniu używanym przez show/list. Wewnętrzna projekcja `lib/delegation-query.js:142` zawiera te informacje. Parent musi interpretować tekst lub czekać na konflikt kolejnego startu, zamiast otrzymać pełne dane.

Skill wymienia `finished` jako status terminalny, a `lib/delegation-status.js:5` definiuje `completed`; terminalny jest też `interrupted`. Skill nie określa obsługi brakującego/sprzecznego VERDICT ani agregacji dwóch review, np. PASS + FAIL. Są to potwierdzone luki kontraktu, a nie dowód, że każdy agent się na nich zatrzyma.

`delegation_inbox` zwraca tylko początek body (240 znaków, `delegation-tools.js:410`), również przy filtrze `id`. Końcowego VERDICT trzeba szukać przez paginację `delegation_show`; instrukcja oczekiwania powinna mówić o tym wprost. W bieżącym audycie raport wymagał trzech stron, a VERDICT znajdował się na ostatniej. Jawne mapowanie ról plan/fix na assignment review/implement także powinno być częścią kontraktu.

### P1 — utracony run może pozostawić zajęty slot

`lib/delegation-service.js:669` zachowuje aktywny slot jako `unknown`, kiedy brak dowodu końca wykonania. Worker naprawia przypadki z trwałym dowodem i timeoutuje starting/cancelling, ale nie ma analogicznej reguły dla running bez aktywnego runu i bez dowodu zakończenia. Potwierdzona ścieżka kodu; nie odtworzono utraty rzeczywistego procesu. Potrzebna naprawa po okresie ochronnym i potwierdzeniu stanu adaptera, bez uznawania chwilowego braku odpowiedzi za zakończenie.

### P1 — health może być zielony mimo zaległego ticka

`lib/delegation-health.js:94` oblicza `staleTick`, ale wynik `ok` nie uwzględnia go. Reprodukcja z workerem `running=true`, `ok=true` i ostatnim tickiem sprzed 60 sekund dała `{ok:true, staleTick:true, lifecycle:"ready"}`. Dodatkowo `tickInFlight` wyłącza warunek stale; potrzebny jest osobny pomiar czasu trwającego ticka.

### P2 — limity są lokalne dla parenta

`lib/delegation-service.js:718` sprawdza `listActiveDelegationsForParent`. Dwa różne parenty mogą więc zlecić implementację w tym samym workspace. To ograniczenie obecnego zakresu blokady, nie błąd fanoutu. Konflikt plików jest ryzykiem do odtworzenia na izolowanym fixture. Brak wspólnej polityki limitu pracy/kosztu dla całego workspace.

### P2 — brak trwałego stanu pętli i wspólnego budżetu zadania

Limit czterech rund i wykrycie powtarzających się findings istnieją w instrukcji skilla; serwer nie liczy rund. Worker ma timeouty starting/cancelling/dispatching, ale w analizowanej warstwie delegacji nie ma wspólnego deadline dla running/waiting ani budżetu całej pętli. Timeouty konkretnych harnessów mogą istnieć niezależnie. Utrata kontekstu parenta utrudnia odtworzenie rundy, poprzedniego implementera i powodu zatrzymania.

### P2 — semantyka pustych ulubionych jest niespójna

`lib/model-role-profiles.js` wyklucza harness bez skonfigurowanych favorites; `lib/delegation-executor.js:119` dopuszcza model, gdy lista jest pusta. Jest to udokumentowany wybór zgodności, ale `model_pick` i bezpośredni start nie oznaczają tego samego przez „dozwolone modele”. Zmiana wymaga jawnej decyzji kompatybilności.

### P2 — reviewer ma bardzo wąski zestaw testów

`lib/sdk/sdk-review-verify.js:28` udostępnia tylko trzy testy dotyczące historii/strumienia, bez testów delegacji. Cursor SDK dodatkowo blokuje natywny shell. Reviewer może analizować kod, ale nie przeprowadzi samodzielnie pełnej weryfikacji tego podsystemu. Rozszerzenie katalogu musi zachować izolację danych i kontrolę skutków ubocznych.

### Do weryfikacji — zewnętrzne MCP w review

`lib/sdk/sdk-plan-guard.js:529` pomija zewnętrzne narzędzia MCP. Ten guard nie daje więc gwarancji blokowania ich mutacji; należy sprawdzić osobno uprawnienia i filtry każdego serwera. Nie stwierdzono w tym audycie skutecznego obejścia konkretnego endpointu. Test certyfikujący review powinien obejmować także tę ścieżkę.

## Plan realizacji

| Etap | Zmiana | Kryterium akceptacji |
|---|---|---|
| 1 — P1 | Ujednolicić statusy skilla z API; dodać outcome/slot/runStopping do MCP; określić brak i konflikt werdyktów oraz agregację fanoutu. | Test kontraktowy obejmuje completed, interrupted, unspecified, PASS+FAIL oraz completed przy nadal zajętym slocie. Kolejny start dopiero po zwolnieniu slotu. |
| 2 — P1 | Rozdzielić capability `preExecDeny`, `abortOnMutation`, `sandboxReadOnly`; zapewnić twarde read-only albo wykluczać niecertyfikowany harness z review wymagającego tej gwarancji. | Próby natywnego edit/shell/MCP w izolowanym workspace nie zmieniają fixture przed odmową. Osobny wynik dla każdego adaptera, bez utożsamiania testu helpera z live coverage. |
| 3 — P1 | Rozdzielić liveness i readiness; uwzględnić zaległy oraz wiszący tick; naprawiać osierocony running po okresie ochronnym. | Zaległy/zablokowany tick powoduje readiness=false; działający tick przywraca gotowość. Potwierdzona utrata runu prowadzi do interrupted i zwolnienia slotu, a chwilowa niedostępność adaptera nie uruchamia duplikatu. |
| 4 — P2 | Zapisać stan workflow: rola, runda, implementer, zbiory findings, werdykt, przyczyna stopu; dodać opcjonalny deadline i budżet. | Restart parenta nie resetuje limitu rund; drugi identyczny FAIL bez zmiany zatrzymuje pętlę; przekroczenie deadline uruchamia anulowanie i czeka na potwierdzenie zatrzymania. |
| 5 — P2 | Ustalić ochronę workspace: blokada zapisu lub izolowane worktree; dodać limit globalny. | Dwa parenty w tym samym workspace nie nadpisują równolegle tych samych plików; niezależne workspace mogą działać równolegle. |
| 6 — P2 | Ujednolicić semantykę favorites z migracją; rozszerzyć audytowany runner review i macierz integracyjną. | Pick/start zgodnie interpretują brak i pustą listę; review uruchamia reprezentatywne testy delegacji na danych tymczasowych. |

Kolejność: kontrakt i gwarancje review, następnie health, potem odporność całej pętli i współbieżność. Trwały stan workflow nie musi oznaczać nowego serwerowego sequencera: parent może nadal sterować przejściami, zapisując stan przez małe API.

## Weryfikacja

- Node v22.23.2; 32/32 plików testowych zakończonych kodem 0: `tests/delegation-*.test.js`, `tests/harness-catalog.test.js`, `tests/mcp-builtin-tools.test.js`, `tests/model-role-profiles.test.js`.
- Każdy plik uruchomiony w oddzielnym procesie; `CRETLI_DATA_DIR` skierowany do katalogu tymczasowego. Testy `node:test` uruchomione z `--test`.
- Log lokalny: `/tmp/cretli-delegation-audit-tests.json` (nietrwały artefakt roboczy).
- Nie uruchomiono przeglądarkowych Playwright ani pełnej macierzy live harnessów. Test wykonania audytu na Cursor SDK jest osobną obserwacją, nie certyfikacją pozostałych adapterów.
- Reprodukcja health: `ok=true` przy `staleTick=true`.
- Delegacja audytu: `4f4c9eca-0c5d-45e9-bfdd-e3822fc60b14`, Cursor SDK / `grok-4.6::effort=medium,fast=false`: status `completed`, raport odczytany w całości (3 strony), `VERDICT: PASS`. PASS oznacza ukończenie audytu i planu, nie brak usterek. Dziecko zgłosiło brak dostępu do natywnego shell i nie uruchamiało testów; 32 pliki zweryfikował parent.
- Zgodnie z zakresem użytkownika zakończono na analizie i planie. Nie uruchamiano implement/fix tylko dlatego, że ogólny skill opisuje również takie przejścia. Dodano wyłącznie ten dokument; bez commit/push.

## Wdrożenie etapów 1–6 (2026-09-20)

Parent nadal steruje pętlą. Nie dodano serwerowego sequencera.

| Etap | Zachowanie | Migracja |
|---|---|---|
| 1 | MCP list/show: `task_outcome`, `slot_occupied`, `run_stopping`, `verdict`. Statusy terminalne: `completed`/`failed`/`cancelled`/`interrupted`. Inbox z `id` paginuje body. | Brak. Skill i parent czekają na `slot_occupied=false`. |
| 2 | Capabilities: `preExecDeny`, `abortOnMutation`, `sandboxReadOnly`. Review bez twardej gwarancji (Codex) jest `review_uncertified`. DeepSeek review: sandbox read-only w runtime DSH. Event abort nie jest blokadą przed zapisem. | `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1` przywraca start review na niecertyfikowanym harnessie (np. Codex). |
| 3 | Health `ok` = readiness (stale/hung tick → false). Osierocony `running` po 60s i potwierdzonym idle → `interrupted`. Niedostępność adaptera zostawia slot. | `ok=true` przy `staleTick=true` już nie występuje. |
| 4 | `delegation_workflow_show` / `update`. Limit rund, ten sam FAIL, opcjonalny `deadline_at` (cancel i czekanie na slot). | Brak wymuszenia: parent zapisuje stan. Domyślne `max_rounds=4` po pierwszym update. |
| 5 | Dwa parenty nie robią równoległego implement/fix w tym samym workspace (`workspace_busy`). Osobne foldery mogą. | Nowa blokada. `CRETLI_DELEGATION_GLOBAL_LIMIT` (0 = bez limitu). |
| 6 | Pusta lista favorites = unset: brak pick i brak start. | `CRETLI_DELEGATION_EMPTY_FAVORITES=all` przywraca stare start-z-dowolnym-id. Runner review: `delegation-contract`, `delegation-wait`, `delegation-executor`, `model-role-profiles`. |

## Aneks — poprawki po review FAIL (2026-09-20)

Parent odtworzył regresje mimo 38/38 plików testowych. Poniższe punkty są poprawkami kodu, nie nowym audytem.

| # | Usterka | Wynik | Uzasadnienie |
|---|---|---|---|
| 1 | Powtórzony `applyDelegationWorkflowPatch` z identycznym FAIL liczył się jako druga recenzja | Naprawione | Idempotencja: `idempotencyKey` / fingerprint. Replay nie podbija `consecutiveSameFail`. Konflikt przy tym samym kluczu i innych parametrach. Licznik `reviewEventCount` rośnie tylko przy odrębnym evencie z werdyktem. |
| 2 | `probeChatRunLiveness` przy `getState=null` zwracał `known:true, busy:false` | Naprawione | Null/undefined, brak adaptera, brak stanu i `run_mismatch` to `known:false`. `releaseDelegationRunSlot` zwalnia tylko przy potwierdzonym idle. Grace orfana liczy od `idleObservedAt`, nie od startu długiego runu. |
| 3 | Dziecko mogło podać `chat_id` parenta w `delegation_workflow_update` | Naprawione | MCP ignoruje/odrzuca obce `chat_id`; zapis tylko dla czatu sesji bez `delegationParentChatId`. HTTP: `workflow_parent_required`. |
| 4 | MCP workflow pisał lokalny persist | Naprawione | Show/update idą przez `getDelegationWorkflow` / `updateDelegationWorkflow` (in-process lub `CretliApiClient`) i trasy `/api/chats/:id/delegation-workflow`. |
| 5 | Persist workflow przy `v:999` zapisywał v1 i gubił pola | Naprawione | `assertWorkflowsJsonSchemaVersion` odrzuca nowszy schemat przed zapisem; plik zostaje. |
| 6 | `resumeExistingDelegation` dla queued/starting omijało bramki | Naprawione | Replay queued/starting sprawdza review/workflow/workspace/global przed startem runu. Działający lub terminalny job nadal zwraca istniejący wynik. |
| 7 | Brak testu deadline→cancel→idle→slot; `void cancel` gubił rejection | Naprawione | Cancel z deadline jest `Promise.then().catch(noteNonFatalFlushError)`. Test integracyjny i test rejection bez `unhandledRejection`. |
| 8 | TOCTOU dwóch parentów / global limit (review); parent nie potwierdzał | Niepotwierdzone jako błąd | Między `parentWidthConflict` a `createDelegationRecord` nie ma `await`; zapis JSON jest synchroniczny. `Promise.all` dwóch parentów w tym samym folderze: jeden `ok`, drugi `workspace_busy`. `Promise.all` przy `CRETLI_DELEGATION_GLOBAL_LIMIT`: jeden `ok`, drugi `global_limit`. Nie dodano mutexa. Normalizacja workspace używa `fs.realpathSync`, więc symlink/alias tego samego folderu jest `workspace_busy`. |

Nie commit / push / restart serwera w tej rundzie.

## Aneks — poprawki po review r2 FAIL (2026-09-20)

Parent odtworzył `A → B → replay A` mimo 41/41 plików. Poniższe punkty są poprawkami kodu, nie nowym audytem.

| # | Usterka | Wynik | Uzasadnienie |
|---|---|---|---|
| 1 | Persist trzymał tylko `lastIdempotencyKey` / `lastPatchFingerprint`. Replay wcześniejszego klucza po innym update liczył się jako nowa recenzja | Naprawione | `appliedPatches` to mapa klucz→fingerprint. Replay dowolnego wcześniej zastosowanego klucza jest no-op. Konflikt innych parametrów działa też po kolejnych update i reload. Wiersze bez mapy są seedowane z ostatniej pary. Update workera bez klucza (deadline) nie czyści mapy. |
| 2 | Fingerprint zrównywał omitted i explicit empty (`''`) dla `stopReason` / `deadlineAt` | Naprawione | Payload fingerprintu zachowuje obecność pola (`{omitted:true}` vs `''`). Omitted = keep, puste = clear. |
| 3 | Deadlock `same_findings` opierał się tylko na findings; findings nie jest zmianą kodu | Naprawione | Jawne `materialRevision` w stanie/API. `same_findings` wymaga dwóch odrębnych FAIL z tym samym `findingsHash` **oraz** niezmienionym `materialRevision`. Ta sama recenzja (ten sam klucz) nie liczy się drugi raz. |
| 4 | Worker `await Promise.all(cancels)` blokował `tickInFlight`, gdy `adapter.cancel` nie wracał | Naprawione | Cancel z deadline jest nieblokujący, z deduplikacją in-flight po delegation/attempt, `catch` rejection, fencing po próbie/run i bez zwolnienia slotu przy `known:false`. |
| 5 | `updateDelegationWorkflow` w kliencie in-process przyjmował dowolne `chatId` | Naprawione | Klient używa `context.chatId` i odmawia dziecku oraz obcemu id. Handler MCP zostaje. Autoryzacja administratora HTTP bez zmian (token integracyjny jest ograniczony do bridge). |

## Aneks — poprawki po review r3 FAIL (2026-09-20)

Parent odtworzył dwa potwierdzone przypadki mimo 54/54 testów r3. Poniższe punkty są poprawkami kodu, nie nowym audytem.

| # | Usterka | Wynik | Uzasadnienie |
|---|---|---|---|
| 1 | Osobny patch `materialRevision` przed kolejnym FAIL z tymi samymi findings dawał `same_findings` (porównanie z bieżącym wierszem, już po bumpie) | Naprawione | Persist trzyma `lastReviewMaterialRevision` / `lastReviewFindingsHash` ze snapshotu ostatniej recenzji FAIL. Kolejny FAIL porównuje z tym snapshotem, nie z dowolnie zaktualizowanym stanem. Osobny patch materiału/findings nie resetuje `consecutiveSameFail` ani `reviewEventCount`. Replay klucza pozostaje no-op. Wiersze legacy bez snapshotu są seedowane z pól FAIL przy wczytaniu. Testy: FAIL src-1 → bump src-2 → FAIL X (`consecutiveSameFail=1`); brak zmiany = deadlock; replay bump; reload/legacy; MCP `delegation_workflow_update`. |
| 2 | Fencing w `.then` workera był za późno: `delegationService.cancel` mutował `latest` po `await adapter.cancel` i stary cancel kończył nową próbę | Naprawione | `cancel` zapisuje fence `attemptId`/`runId` przed `await`, sprawdza go przed każdą mutacją po powrocie (gałąź aktywna, terminal/`runStopping`, błąd adaptera). Stale → `{skipped,stale}` bez `finishDelegation` i bez `releaseDelegationRunSlot`. `finishDelegation` używa istniejącego `isDelegationEventCurrent` (attempt + run). Worker nadal ma nieblokującą deduplikację deadline i fencing w `.then`. Testy: odroczony cancel a1 przy a2 idle/busy, reject cancel, terminal slot; bezpośrednio `service.cancel` i `tickDelegationRuntime`. |

Nie commit / push / restart serwera w tej rundzie.
