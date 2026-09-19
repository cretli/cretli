# Modernizacja delegacji — etap III (rewizja po review Astra)

Data: 2026-09-19. Rewizja po przeglądzie `1f3bd900` (tylko analiza, bez implementacji).
Kontynuacja TODO `87c5390c` (II) i `e2af299f` (IIb). TODO planu: `c7cb3846`.
Status: **A/B przyjęte; C z ograniczeniami; D10 poza zakresem.** Implementacja w drzewie `next/2026-09-06` (TODO `c7cb3846` done). Luki odbioru: [etap IIIb](DELEGATION-MODERNIZATION-PHASE-3B.md).

Baza regresji (nie odtwarzać): B1–B9, R1–R8, P2-R1–R6, C2/C3, live C1. Istniejące testy mailbox/followup/phase2b zostają.

## Werdykt przeglądu (przyjęty)

Kierunek A → B → opcjonalne C jest trafny. Pierwsza wersja D1–D10 nie była kompletną specyfikacją. Poniżej jest kontrakt do zlecenia implementacji.

## Fakty z kodu (sprawdzone)

- `sendDelegationReply` kolejkuje mailbox i bierze **bieżące** `delegation.attemptId`. Narzędzie `delegation_reply` nie ma `attempt_id`.
- `markDelegationReportDeliveredByMailbox` ustawia `reportDeliveredAt` / `reportDeliveryId`, **nie** terminalny status joba.
- `sdkRunFinished` w `delegation-run-bridge.js` woła `finishDelegation` (completed/cancelled/failed).
- `createAndStart` → `active_delegation_exists`; retry → `still_active` / `parent_busy`. MCP mapuje CONFLICT dla `active_delegation_exists`, **nie** widać `still_active` / `parent_busy` w tej samej gałęzi `errors.js`.
- `POST .../retry-delivery` ponawia **wszystkie** mailbox `failed|uncertain` danej delegacji, bez zawężenia próby/kierunku.
- `lib/delegation-lifecycle.js` to stan **procesu**, nie maszyna stanów joba.
- Centrum i retry-task/retry-delivery w IIb już istnieją; brakuje potwierdzeń, błędów API, Stop/ack z twardym skutkiem, fencing próby.

## Kontrakt (zanim kod)

`final_report` to narzędzie w **wciąż działającym** runie dziecka. Sama nazwa nie oznacza sukcesu zadania (raport może opisywać porażkę).

Rozdzielić zawsze:

| Pojęcie | Znaczenie |
|---|---|
| Job status | queued/starting/running/waiting_for_input/cancelling/completed/failed/interrupted/cancelled |
| Outcome zadania | deklarowany wynik: sukces / porażka / zablokowane / nieokreślony; nie wywodzić go automatycznie z prozy raportu |
| Attempt / run | `attemptId` ≠ `runId` ≠ `acceptRequestId` |
| Slot rodzica | czy wolno `delegation_start` kolejnego zadania |
| Mailbox | queued/dispatching/delivered/failed/uncertain — dostarczenie do rodzica |
| reviewed/ack | osobno; final nie oznacza reviewed |

Przyjęty `final_report` kończy próbę wykonania statusem `completed` (wykonawca złożył raport), bez automatycznego uznania zadania za udane lub reviewed. Jawny outcome zadania pozostaje osobnym polem; brak deklaracji oznacza `nieokreślony`. Zakończenie przez adapter bez final_report zachowuje dotychczasowe completed/failed/cancelled. Terminalnego wyniku nie zastępuje późniejszy callback; późniejszy błąd adaptera jest diagnostyką tej samej próby.

Zwolnienie slotu **nie** zależy od tego, czy zajęty rodzic przyjął wiadomość. Wynik i intencja dostarczenia muszą być trwale odtwarzalne przed potwierdzeniem przyjęcia final_report. Zapis atomowy albo trwały intent z deterministycznym recovery; awaria między zapisami nie może zgubić raportu.

Terminalny job i slot to osobne warunki: do potwierdzonego końca runu dziecka slot pozostaje zajęty również dla retry. Po final_report wykonawca dostaje odpowiedź narzędzia i może jedynie zakończyć run; zablokować dalszą pracę tej próby, a niedokończony run wygasić kontrolowaną ścieżką stop. Samo oznaczenie obsolete nie dowodzi zatrzymania. Przy niepotwierdzonym stop zwracać blokadę z przyczyną `run_stopping` lub `unknown`, bez nowego wykonawcy. Po potwierdzeniu idle slot zwalnia się automatycznie, bez ręcznego cancel; bramka mierzy ten stan, nie obiecuje startu jeszcze podczas obsługi narzędzia final_report. To nie jest pula równoległa (D10).

Idempotencja reply obejmuje nadawcę, odbiorcę, delegację, próbę, rodzaj wiadomości, outcome i treść: ten sam klucz + ten sam payload = replay; zmiana payloadu = conflict. Różne klucze, identyczny final tej samej próby = replay; różne finały = pierwszy trwale przyjęty wygrywa, drugi zwraca conflict. Automatyczny raport adaptera po ręcznym final nie tworzy drugiej wiadomości. **Nie** ciche nadpisanie.

Wyścig cancel/report: final przyjęty przed cancel pozostaje terminalny; cancel może jeszcze zatrzymać kończący się run. Jeżeli wcześniej przyjęto cancel, późny final można zachować jako diagnostykę starej próby, ale nie jako nowe completed ani nowy run. Brak wiarygodnego przypisania legacy reply do próby nie upoważnia do jej zakończenia. Identyfikator podany przez klienta trzeba porównać z kontekstem wykonującego runu; nie wystarczy podstawić aktualnego attemptId z rekordu.

## Dostawa A — D1+D2 atomowo, potem D3

### D1+D2 / P1 — Wynik próby, fencing, slot

Jedna dostawa. Kod: `delegation-status`, `delegation-service`, `delegation-attempt`, `delegation-run-bridge`, `delegation-mailbox` — nie `delegation-lifecycle.js`.

Wymagania:

1. `final_report` (i analogiczny finish adaptera) zapisuje trwały wynik próby; slot zwalnia się po potwierdzeniu końca runu według kontraktu powyżej, bez auto-reviewed.
2. Reply musi nieść wiarygodne `attemptId`/`runId` (narzędzie + walidacja serwera). Reply ze **starej** próby po retry nie mutuje nowej.
3. Kolejności: report→cancel, cancel→report, manual final vs `sdkRunFinished` (w tym error), late accept po cancel/interrupt.
4. Drugi `delegation_start` (inne zadanie) przechodzi bez ręcznego cancel, **bez** dwóch aktywnych jobów tego rodzica.
5. Restart/crash między zapisem wyniku a outbox: raport nie ginie, nie powstaje drugi run.
6. Reconciliation istniejących `running` z final_report sprzed poprawki: tylko przy **dowodzie** końca konkretnej próby (final z pasującą tożsamością próby/runu albo finish adaptera) oraz kontroli runu przed zwolnieniem slotu. Brak przypisania legacy = unknown, nie „idle = sukces”. Bez migracji live `data/`.

Nie obiecywać exactly-once na zewnętrznym modelu.

### D3 / P1 — Bloker, nie kolejka

Bez „zastąp/poczekaj” i bez kolejki rodziców.

Zdefiniować:

- `job_in_progress` — naprawdę trwa (`inFlightStarts`, `waiting_for_input`, `cancelling`, żywy `runId`, pending accept).
- `stale_running` — rekord active, ale istnieje trwały final lub event końca przypisany do tej samej próby (D1). Naprawa statusu nie zwalnia slotu bez potwierdzenia końca runu; **nie** sam wiek ani `getState()==null`.
- `unknown` — zostaje unknown; bez auto-retry.

HTTP, MCP i UI zwracają `delegationId`, `attemptId`, przyczynę. Dodać mapowanie MCP dla `still_active` i `parent_busy` (dziś dziura obok `active_delegation_exists`).

## Dostawa B — D4 (z brakami D6) i D5

### D4 / P1 — Naprawy, obiekt mutacji, Stop/ack

Rozdzielić w UI/API:

- `acceptState=uncertain` (wykonanie),
- mailbox uncertain/failed,
- queued/dispatching do zajętego rodzica,
- outbox historii / report delivery.

Retry-delivery mutuje **wskazaną** wiadomość i próbę, nie wszystkie `failed|uncertain` delegacji. Retry-task zwiększa `attemptCount` dokładnie o 1 i nie jest retry-delivery. Podwójne kliknięcie / dwaj klienci / utrata odpowiedzi = brak dodatkowego skutku.

„Zostaw uncertain” = brak mutacji. Osobny stan operatorski jest poza zakresem III. **Nie** czyścić niepewności przez ack reviewed. Zwykłe queued/dispatching do zajętego rodzica oznacza oczekiwanie, a nie przycisk wymuszenia kolejnego startu. Dla uncertain mailbox potwierdzenie musi uprzedzać, że poprzednia próba mogła zostać przyjęta. Przed retry sprawdzić dostępny lookup akceptacji; nie obiecywać exactly-once u zewnętrznego odbiorcy.

Potwierdzenie przed mutacją; błąd API widoczny (dziś `onListClick` go gubi).

Dołożyć to, czego IIb nie dowieźło (dawne D6, scalić):

- Stop → idle/terminal, run nie żyje;
- ack → `acknowledged`, bez nowego runu;
- dokładna liczba runów/prób/dostarczeń, nie `attemptCount >= 2`.

IIb już ma HTTP retry-delivery×2 i Playwright obu retry — nie powtarzać jako nowość.

Health vs lista: `pendingMailbox` oznacza queued/dispatching/uncertain; failed liczyć osobno. Filtr „wymaga dostarczenia” obejmuje sumę tych stanów i zaległy outbox. Liczby wiadomości nie muszą równać się liczbie jobów; opisy UI mają podawać jednostkę i zakres. Uwzględnić priorytety filtrów uwagi oraz mailbox bez przypisania do joba. Lista >40 musi być osiągalna (paginacja); porównywać pełny zbiór tego samego workspace, nie pierwszą stronę.

Testy tylko izolowane. Zero Stop/Retry/ack na jobach użytkownika.

### D5 / P1 — Stary dist, jedna ścieżka build

IIb już wgrało centrum one-shotem. Teraz: **powtarzalna** procedura, nie skip=PASS.

Wybrana ścieżka III: **udokumentowany one-shot operatorski**, bez zmiany skryptu startu i bez dev-middleware.

Wymagane: repo checkout z `node_modules` (webpack + loaders from `package.json`), Node 22.

Katalog roboczy: `app_front`.

```bash
CRETLI_FRONT_HMR=0 ../node_modules/.bin/webpack --config webpack.dev.js --no-watch
```

Kod wyjścia `0`. Wynik: `public/dist/app/index.bundle.js`, `public/dist/app/index.css` (oraz login/embed). Odświeżyć Settings → Delegacje bez restartu procesu. `npm run start:no-hmr` dziś nie buduje frontu; `webpack.dev.js` przy HMR=0 nadal `watch: true` — one-shot wymaga `--no-watch`. Izolowany odbiór może podać `--output-path` poza live `public/dist`.

Odbiór: start z czystego/starego dist, HMR=0, udokumentowany build, **ekran** Settings → Delegacje i assety. Nie sam string w bundle. Nie pisać do live `public/dist` z testu izolowanego. Cache bust mtime już jest.

## Dostawa C — osobno zaliczane albo jawne odroczenie

Jeśli C odroczone: zamykać jako **„A/B przyjęte; C odroczone”**, nie „wszystkie bramki ukończone”.

### D7 / P2 — ≥1k summaries na kopii

Syntetyczny katalog (nie live `data/`), co najmniej 1000 rekordów. Stabilny cursor przy równych timestamp i przy dopisie między stronami: brak duplikatów i pominięć rekordów należących do początkowego zbioru, o ile nie zostały usunięte; nowsze dopiski mogą wymagać odświeżenia od pierwszej strony. Summaries bez prompt/report. Retencja nie rusza active/uncertain ani pending delivery/outbox. Poprawność stanowi bramkę PASS/FAIL. Wydajność to jawny pomiar bazowy, bez deklaracji osiągnięcia nieustalonego SLA: zapisać backend, sprzęt/Node, rozmiary danych, 5 rozgrzewek i 30 pomiarów listy, p50, pamięć procesu i bajty odpowiedzi. Bench 200 nie zastępuje.

### D8 / P2 — Guardy adapterów

Macierz transportów z obecnego katalogu capabilities: opencode, openrouter, codebuddy, deepseek, qwen, codex. Dla każdego wskazać istniejącą ścieżkę serwerową, kontrolowany SDK/mock i dowody: odczyt fixture w review, odmowa mutacji przed skutkiem ubocznym, cancel z potwierdzonym końcem runu. Mock ogólnego service nie zastępuje przejścia przez guard konkretnego adaptera. Brak możliwości lokalnej integracji oznacza jawne odroczenie tego wiersza, nie PASS. Coverage **per adapter**: unit / integration / live. Brak płatnego live nie degraduje integration do unit. Nie dublować TODO sesji DeepSeek. W implementacji III nie wołać płatnych modeli.

### D9 / P2 — Checklist SQLite, nie nowy migrator

Kod migrate/rollback/P2-R1–R6 zostaje. Odbiór: izolowany dataset, polecenia, dry-run bez zapisu, backup/hash, migracja, dopisanie po switchu, rollback **merge**, ponowna migracja bez utraty. Marker JSON `backend=sqlite`: samo cofnięcie env **nie** wraca do JSON. Mailbox też. Nie kopiować aktywnego `data/`.

## Poza zleceniem implementacji III

### D10 / P3 — Pula wykonawców

Osobna decyzja produktowa. Nie w scope implementacji III. Worktree nie rozwiązuje limitów ani konfliktów plików. Nie blokuje A/B.

## Kolejność

1. Kontrakt (ten dokument) — **zrobione w planie**.
2. D1+D2, potem D3.
3. D4 (z Stop/ack), D5 niezależnie ale przed odbiorem UI bez HMR.
4. D7/D8/D9 osobno lub odroczenie.
5. D10 nigdy w tym zleceniu.

## Live (opcjonalny odczyt)

Zalogowany GET health + odczyt centrum/bundla. Zanotować token procesu, backend, worker/lifecycle/stale, liczniki. Historyczny PASS IIb **nie** dowodzi wdrożenia kodu III. Bez crash-testu, migracji `data/`, restartu `:3011`, płatnych modeli, mutacji jobów użytkownika.

## Macierz odbioru i dowody do raportu implementacji

| Bramka | Środowisko | Wymagany dowód |
|---|---|---|
| A — zakończenie i slot | Izolowany serwer, rzeczywiste HTTP/MCP, kontrolowany adapter | Final przy zajętym rodzicu: terminalny wynik zachowany mimo queued mailbox; po końcu dziecka nowe zadanie startuje bez cancel; równoczesne dwa starty dają najwyżej jeden nowy run. |
| A — kolejności i recovery | Izolowane dane/proces | Report/cancel w obu kolejnościach, late accept, final starej próby po retry, manual/auto final, zmieniony payload przy tym samym kluczu, crash na granicy zapisu; bez utraty raportu i mutacji nowej próby. |
| A — diagnostyka | HTTP/MCP/UI izolowane | Busy, waiting_for_input, pending accept, run_stopping, stale i unknown mają właściwy blocker/próbę/przyczynę; brak automatycznego retry unknown. |
| B — naprawy (D4 + dawne D6) | Izolowane API i Playwright | Wskazana wiadomość/próba/kierunek; retry-task dokładnie +1, retry-delivery +0 prób zadania; dwa klienty i utrata odpowiedzi bez ponowienia tej samej operacji; anulowane potwierdzenie bez mutacji; błędy widoczne, Stop faktycznie kończy run, ack nie uruchamia runu. |
| B — zakres i widoczność | Izolowane UI, >40 jobów | Paginacja, poprawne liczniki i filtry, izolacja workspace/widget, klawiatura/PL/EN/mobile zachowane. |
| B — HMR=0 | Osobny checkout i katalog dist | Czysty oraz stary dist, one-shot, działające Settings → Delegacje i JS/CSS bez restartu procesu; sam string w bundle lub skip nie jest PASS. |
| C | Wyłącznie syntetyczny dataset/kontrolowane adaptery | D7 pomiar i poprawność cursor/retencji; D8 macierz coverage; D9 protokół migracji i rollback z hashami delegacji oraz mailbox i zachowaniem zapisów po przełączeniu. |

Każda dostawa raportuje diff, wykonane testy, wyniki, ograniczenia i artefakty. Zachować oraz uruchomić odpowiednie istniejące regresje mailbox, review-followup, delivery-acceptance, outbox-concurrency, phase2/phase2b i Playwright; rozszerzać tylko brakujące scenariusze. D6 jest scalone z D4, nie osobnym zadaniem. Nie oznaczać odroczenia jako PASS.

## Zasady

Nie commit bez polecenia. Kod ≠ wdrożenie. Zachować regresje I/II/IIb.
