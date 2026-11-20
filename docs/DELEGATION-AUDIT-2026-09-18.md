# Audyt delegowania czatów Cretli — 2026-09-18

## Końcowy odbiór implementacji — 2026-09-18

Po trzech rundach Grok 4.6 i weryfikacji nadrzędnej przyjęto implementację w zakresie jednej instancji zapisującej. Wcześniejsze opisy braków poniżej są historią odbioru, nie bieżącą listą otwartych usterek.

Rodzic uruchomił 17 zestawów testowych wskazanych w trzeciej rundzie: wszystkie przeszły. Dodatkowo dopisał `tests/delegation-delivery-acceptance.test.js`: potwierdzenie raportu w historii i jego idempotencja, odrzucony zapis historii pozostający w outbox z backoff oraz timeout anulowania dla zajętego i bezczynnego wykonawcy. Test najpierw wykazał regresję: zdarzenie `acknowledged` było tłumione przez `finished`, ponieważ współdzieliły ID rewizji statusu. Deduplikacja uwzględnia teraz także nazwę zdarzenia i próbę. Po poprawce test przeszedł; ponownie przeszły też flow, mailbox, criteria, outbox-concurrency i runtime-worker. Lint serwisu i nowego testu: PASS.

Izolowany test Playwright `playwright.delegation-card.config.js`: 1/1 PASS na systemowym Chromium, prawdziwy komponent karty i klient API z fixture handlerami oraz mock endpointami. Obejmuje replay/reconnect, retry, cancel, błąd API, uncertain, ack i mailbox retry; nie jest pełnym E2E aktywnej instancji Cretli. Skrypt `.tmp/delegation-worker-rejection.mjs` kończy się teraz kodem 0 (`Worker survived`). Łącznie uruchomiono 18 zestawów Node oraz test przeglądarkowy.

Odbiór T8/R2 opiera się na testach migawek prób, potwierdzeń intencji, równoległych zapisów oraz symulowanych punktów awarii; nie wykonywano fizycznego restartu produkcji. Odbiór T9/R3 obejmuje worker runtime, backoff, izolację błędów magazynu, start/stop oraz timeouty. TODO implementacyjne oznaczono jako zakończone.

Ograniczenia pozostają jawne: magazyn JSON nie obsługuje wielu procesów zapisujących (test ujawnił utratę zapisów); brak walidacji live DeepSeek/innych płatnych modeli; brak wdrożenia i restartu aktywnej aplikacji. Nowy worker zacznie działać po załadowaniu zmienionego serwera przy przyszłym starcie. Migracja bazy i pula wykonawców pozostają opcjami zależnymi od potrzeb wdrożenia, nie częścią wykonanego rollout.

## Weryfikacja pierwszej implementacji

Ponownie uruchomiono 14 zestawów wskazanych przez wykonawcę — wszystkie przeszły. Nie przyjęto jednak pełnego zakończenia T1–T12. Lokalny skrypt `node .tmp/delegation-review-followup.mjs` odtworzył dwa blokery:

- Anulowanie podczas opóźnionego startu zapisuje `cancelled`, ale po przyjęciu promptu wykonawca nadal działa. Samo zachowanie terminalnego statusu nie wystarcza do zatrzymania pracy.
- Intencja mailbox próby A, opróżniana podczas działającej próby B, otrzymuje `deliveredAt`, choć wiadomość nie powstaje. Outbox potrzebuje migawki wyniku i potwierdzeń po konkretnym ID oraz próbie, dopiero po udanej publikacji.

Przegląd kodu wykazał ponadto brak okresowego worker/reconciliation i backoff; timeouty w funkcji boot nie zapewniają działania podczas pracy serwera. Test modelu karty nie stanowi weryfikacji UI. Profil review wymaga potwierdzenia działającego odczytu repo, szczególnie dla DeepSeek. Benchmark 200 rekordów nie zastępuje oceny konkurencji procesów. TODO przywrócono do `doing` z pozycjami odbioru R1–R6; poniższe opisy audytu pozostają zapisem stanu sprzed implementacji.

## Zakres i wniosek

Analiza bieżącego drzewa roboczego, w tym istniejących niezacommitowanych zmian. Przejrzano serwis delegacji, mailbox, persystencję, most zdarzeń wykonawców, kontekst raportów, API HTTP/MCP oraz obsługę kart w UI. Nie wdrażano poprawek produkcyjnych.

System ma użyteczne podstawy: delegacje działają bez otwartej przeglądarki, zadanie ma zapisany snapshot, istnieją identyfikatory prób, kolejka odpowiedzi, kontrola aktualności zdarzeń i obsługa restartu. Największy problem stanowi niespójność tożsamości: wykonanie rozróżnia próby, lecz mailbox, potwierdzenie raportu i część deduplikacji nadal traktują całą delegację jako pojedyncze zdarzenie. Dodatkowo stan jest zapisywany kilkoma niezależnymi ścieżkami.

Odtworzono 9 problemów w izolowanym środowisku z adapterem mock. Nie jest to dowód, że wszystkie wystąpiły już na produkcji. Nie wykonywano płatnych wywołań modeli ani testów E2E przeglądarki.

## Jak działa obecny przepływ

1. UI lub MCP zleca zadanie z zapisanego planu, wiadomości albo jawnego tekstu.
2. `delegation-service.js` sprawdza źródło, model, klucz idempotencji i ograniczenie jednej aktywnej delegacji na rodzica.
3. Powstają rekord delegacji i osobny czat wykonawcy. Relacja komunikacyjna `delegationParentChatId` jest niezależna od grupowania w sidebarze.
4. `chat-run-service.js` uruchamia adapter wykonawcy, a `delegation-run-bridge.js` przekłada zdarzenia pokoju na status delegacji.
5. Raport pojawia się w historii rodzica i może uruchomić jego następną turę przez mailbox. Zajęty rodzic otrzymuje odpowiedź po zwolnieniu.
6. Dla delegacji planowych istnieje dodatkowa ścieżka dołączania niedostarczonych raportów do promptu. „Dostarczone” i „zweryfikowane” to osobne pojęcia.
7. Retry używa tego samego czatu i rekordu delegacji, podmieniając `attemptId`. Po restarcie niepotwierdzone aktywne zadania stają się `interrupted`.

## Potwierdzone problemy

Priorytet P1 oznacza pierwszą serię napraw, P2 — kolejną serię. Kolejność nie oznacza potwierdzonego incydentu bezpieczeństwa.

### B1 — P1: kolejne odpowiedzi wykonawcy przepadają

**Kod:** `lib/delegation-mailbox.js:407–438`, `lib/persist/delegation-mailbox-persist.js:152`.

`sendDelegationReply` z tekstem „Progress only”, a potem „Final result” i innym kluczem idempotencji zwraca dwa razy ten sam rekord z pierwszą treścią. `findMailboxReplyForDelegation` rezerwuje tylko jeden slot odpowiedzi na całe zadanie. Skutek: postęp lub pytanie może wyprzeć końcowy raport, a odpowiedź API sugeruje powodzenie.

**Naprawa:** rozróżnić wiadomości postępu, pytania i raport końcowy. Zwykłe wiadomości deduplikować po kluczu żądania i jego treści; raport końcowy po delegacji oraz próbie. Ręczny raport i automatyczny raport mogą współdzielić slot wyłącznie wtedy, gdy są tym samym wynikiem tej samej próby.

**Odbiór:** dwie różne wiadomości docierają; ponowienie tego samego żądania nie tworzy duplikatu; ponowne użycie klucza ze zmienioną treścią zwraca konflikt.

### B2 — P1: raport nowej próby jest tłumiony przez poprzednią odpowiedź

**Kod:** `lib/delegation-mailbox.js:94–138`, `lib/delegation-service.js:743`, `lib/delegation-report-context.js:20`.

Po dostarczeniu odpowiedzi, zakończeniu zadania i retry nowa próba nie tworzy nowego raportu w mailbox. Klucz `delegation-auto-reply:${id}` i wyszukiwanie odpowiedzi nie zawierają `attemptId`. W reprodukcji po zakończeniu drugiej próby nadal istniała jedna odpowiedź z pierwszej próby. Dodatkowo potwierdzanie dostarczenia zapisuje wynik po samym ID delegacji, więc spóźniona stara wiadomość może oznaczyć nową próbę jako dostarczoną. Ten ostatni wariant wynika z analizy kodu; osobna reprodukcja nie była wykonywana.

**Naprawa:** `delegationAttemptId` w wiadomości, unikalność raportu końcowego per próba, potwierdzenie dostarczenia z kontrolą próby oraz migawki raportu. Migracja starych rekordów bez przypisywania ich automatycznie do bieżącego retry.

**Odbiór:** próby A i B mają osobne raporty; spóźnione zdarzenia A nie zmieniają B; collector nie ukrywa B z powodu mailbox A.

### B3 — P2: retry zachowuje `unverified=false`

**Kod:** `lib/delegation-service.js:743–807`, `app_front/lib/sdk-rich-view.js:2783`.

Sekwencja ukończ → potwierdź przegląd → ponów pozostawia `unverified=false`. `acknowledgedAt` jest czyszczone przy zmianie statusu, ale flaga weryfikacji nie. Nowy wynik może nie mieć ostrzeżenia o braku weryfikacji.

**Naprawa:** nowa próba rozpoczyna się z `unverified=true`, pustymi potwierdzeniami i identyfikatorami dostarczenia. Docelowo weryfikacja należy do próby i konkretnego raportu.

**Odbiór:** potwierdzenie A nigdy nie potwierdza B; po ukończeniu B UI pokazuje wynik wymagający przeglądu.

### B4 — P1: odrzucony długi prompt blokuje następne delegacje

**Kod:** `lib/delegation-service.js:423–464,550–565`, `lib/delegation-prompt.js:11,68–81`.

Rekord `queued` powstaje przed walidacją limitu promptu. Tekst 500 000 znaków zwrócił `plan_too_large`, lecz pozostawił aktywny rekord bez uruchomionego wykonawcy. Następna poprawna delegacja zwróciła `active_delegation_exists`. Limit wynosi 100 000 znaków, mimo że wspólny kod błędu nazywa się `plan_too_large` także dla źródła tekstowego.

**Naprawa:** budować i walidować prompt przed utworzeniem rekordu; każdą porażkę po rezerwacji kończyć kontrolowanym stanem błędu i zwalniać aktywny slot.

**Odbiór:** granica limitu i jej przekroczenie dla wszystkich źródeł; odrzucone żądanie nie blokuje poprawnego zadania ani nie tworzy osieroconego czatu.

### B5 — P2: drugie oczekiwanie na użytkownika nie aktualizuje historii

**Kod:** `lib/delegation-service.js:107–143`, `lib/delegation-run-bridge.js:77–89`.

Deduplikacja historii używa `(delegationId, event, attemptId)`. Sekwencja `waiting_for_input → running → waiting_for_input` w tej samej próbie pozostawiła ostatnią kartę `running`, choć rekord zadania wskazywał `waiting_for_input`.

**Naprawa:** każde rzeczywiste przejście otrzymuje numer rewizji lub ID zdarzenia. Deduplikacja dotyczy powtórnej dostawy konkretnego zdarzenia, a nie ponownego wystąpienia nazwy statusu.

**Odbiór:** dwa i więcej cykli oczekiwania są widoczne po odtworzeniu historii; powtórzenie tej samej dostawy nie dubluje zdarzenia.

### B6 — P1: retry omija walidację trybu rodzica i dostępności modelu

**Kod:** porównać `lib/delegation-service.js:268,415` z `:743`.

Po zakończeniu zadania zmieniono rodzica na Ask i ustawiono kontrolę dostępności modelu na `false`. `retry` nadal uruchomił wykonawcę. Start nowej delegacji ma odpowiednie blokady; retry ich nie powtarza. Reprodukcja dotyczy kontraktu serwisu z mockiem; poszczególne realne adaptery mogą dodatkowo odrzucić wykonanie.

**Naprawa:** wspólna walidacja start/retry/replay, wykonywana przed zmianą rekordu: tryb, dostępność harnessu i modelu, workspace oraz istnienie wykonawcy. Zmiana modelu powinna być jawna i zapisana w nowej próbie.

**Odbiór:** Ask i wyłączony model blokują retry przed startem; stary raport i historia pozostają zachowane.

### B7 — P2: `/ack` i `/retry` pomijają zadany workspace

**Kod:** `lib/routes/delegations-routes.js:129–149`.

GET tej samej delegacji z obcym `workspaceFolder` zwrócił 403, a POST `/ack` zwrócił 200. Obie trasy `/ack` i `/retry` pomijają `rejectIfOutOfWorkspace`. Sprawdzenie `widgetInstallationId` nadal istnieje: nie jest to dowód obejścia logowania czy izolacji widgetów. To potwierdzona niespójność zakresu operacji API; reprodukcja objęła `/ack`, brak kontroli `/retry` stwierdzono w kodzie.

**Naprawa:** współdzielona kontrola zakresu wszystkich operacji; określenie, kiedy workspace jest obowiązkowy dla klientów ograniczonych do projektu.

**Odbiór:** macierz GET/start/cancel/ack/retry/mailbox dla własnego i obcego workspace oraz różnych instalacji widgeta.

### B8 — P1: zakończenie podczas startu jest nadpisywane przez `running`

**Kod:** `lib/delegation-service.js:79–83,593–626,811–816`.

Adapter testowy zapisuje `failed` przed rozstrzygnięciem swojej obietnicy `start`, po czym zwraca zaakceptowany run. Serwis kończy ze statusem `running` i zachowanym tekstem „Immediate failure”. `transition` sprawdza stary obiekt `record`, a nie najnowszy zapis. Retry zapisuje `running` bez kontroli przejścia. To deterministyczna reprodukcja wyścigu na granicy serwis–adapter, nie pomiar częstości u rzeczywistych dostawców.

**Naprawa:** jeden mechanizm przejść z oczekiwaną rewizją i `attemptId`; po `await` odczytać stan i nie cofać stanów terminalnych. Przetestować też cancel podczas startu oraz zakończenie bezpośrednio po akceptacji. Macierz przejść musi obsługiwać wczesne zakończenie lub kolejkę takich zdarzeń.

**Odbiór:** synchroniczne i asynchroniczne failed/completed/cancelled podczas start/retry nie wracają do `running`; historia i rekord zgadzają się.

### B9 — P1: uszkodzony JSON delegacji może zostać bezgłośnie nadpisany

**Kod:** `lib/persist/delegations-persist.js:27–39`.

Po zapisaniu niepoprawnego JSON `loadDelegations()` zwrócił pustą listę. Utworzenie nowej delegacji zastąpiło plik poprawnym dokumentem zawierającym tylko nowy rekord. Brak pliku, błąd odczytu i uszkodzenie danych są traktowane tak samo. Mailbox ma już częściowo lepszy wzorzec — `MailboxCorruptError`.

**Naprawa:** odróżnić brak pliku od uszkodzenia i błędu I/O; przerwać zapis, zachować oryginał, zgłosić diagnostykę, walidować strukturę i wersję. Dodać odzyskiwanie z kopii lub dziennika.

**Odbiór:** uszkodzony JSON i niepoprawny schemat nie są nadpisywane; operator może odzyskać dane; niedostępny magazyn nie wygląda jak pusta lista.

## Modernizacja po naprawach

- **Próby jako osobne rekordy.** `Delegation` opisuje zadanie, `Attempt` przechowuje model, tryb, run, wynik i weryfikację, `MailboxMessage` odnosi się do konkretnej próby. Zachować raporty wcześniejszych prób zamiast nadpisywać je przy retry.
- **Spójny zapis i outbox.** Zmiana statusu oraz zamiar publikacji raportu powinny powstawać razem. Worker dostarcza zdarzenia z idempotencją. Obecnie crash pomiędzy zapisem zakończenia a utworzeniem mailbox może przerwać automatyczny powrót raportu; to ryzyko wynikające z kodu, bez testu crash injection w tym audycie.
- **Persystencja dopasowana do wdrożenia.** Obecne pełne odczyty i zapisy JSON oraz lokalne mapy blokad nie dają transakcji między procesami. Dla jednej instancji rozważyć transakcyjny magazyn lokalny; dla wielu — wspólny magazyn z wersjonowaniem i lease właściciela. Wybór technologii poprzedzić pomiarem obciążenia. Nie wykonywano benchmarku ani próby wieloprocesowej.
- **Odtwarzanie i diagnostyka.** Dodać reconciliation działające okresowo, bezpieczne limity czasu `starting/cancelling/dispatching`, backoff, licznik prób, osobną kolejkę błędów i stan „wynik niepewny”. Timeout nie powinien oznaczać sukcesu ani automatycznie powtarzać potencjalnie wykonanej operacji.
- **Uprawnienia review.** Obecnie `assignment=review` uruchamia Agent, a zakaz edycji wynika z promptu. Rozważyć profil narzędzi tylko do odczytu, niezależny od nazwy trybu SDK. Nie stwierdzono w tym audycie konkretnej nieautoryzowanej edycji.
- **Lepszy panel delegacji.** Pokazać próbę, czas trwania, model, źródło zadania i osobno stan wykonania, dostarczenia oraz przeglądu. Dodać retry delegacji z historii, prezentację błędów cancel, historię prób i jasną obsługę `uncertain`. API `postDelegationRetry` istnieje, lecz karta delegacji obecnie oferuje otwarcie, cancel i ack.
- **Raporty i kontekst.** Ujednolicić schemat: zmiany, testy, odstępstwa, blokady, artefakty. Budżetować kontekst raportów; duże wyniki stronicować i udostępniać na żądanie. „Run przyjął wiadomość” nie oznacza „model ocenił wynik”.
- **Równoległość dopiero na końcu.** Jedna aktywna delegacja na rodzica jest świadomym ograniczeniem, nie błędem. Opcjonalna pula wykonawców wymaga limitów, zależności zadań, agregacji wyników oraz ochrony wspólnych plików, np. osobnych worktree. Samo usunięcie blokady rodzica pogorszy obecne wyścigi.

## Kolejność wdrożenia

1. B9 i B4: ochrona danych oraz brak osieroconych rezerwacji.
2. B8: wspólne, wersjonowane przejścia stanu.
3. B1–B3: wiadomości i weryfikacja per próba wraz z migracją istniejących danych.
4. B5–B7: historia zdarzeń oraz wspólna walidacja i zakres API.
5. Outbox, odtwarzanie po awarii i testy crash injection.
6. UI, diagnostyka, profil review, budżety kontekstu.
7. Pomiar wydajności i dopiero potem migracja magazynu / opcjonalna równoległość.

## Weryfikacja

Przeszło 8 istniejących plików testowych uruchomionych osobno przez `node tests/<nazwa>.test.js`:

- `delegation-flow`
- `delegation-mailbox`
- `delegation-review-upgrade`
- `delegation-executor`
- `delegation-prompt`
- `agent-run-state`
- `chat-run-accept`
- `sdk-chat-run-adapter`

Dodatkowy lokalny skrypt diagnostyczny: `.tmp/delegation-audit-20260918.mjs`, uruchomienie `node .tmp/delegation-audit-20260918.mjs`. Skrypt używa `tests/helpers/isolated-data-dir.js`, osobnego katalogu danych i adapterów mock; nie modyfikuje magazynu aplikacji. Potwierdził 9 opisanych zachowań. Jego asercje dokumentują obecne błędy — przy wdrażaniu napraw należy zamienić je na regresje oczekujące prawidłowego zachowania. `.tmp` jest lokalnym artefaktem, nie częścią trwałego zestawu testów.
