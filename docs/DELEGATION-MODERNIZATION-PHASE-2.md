# Modernizacja delegacji — etap II: odporność, diagnostyka i skalowanie

Data: 2026-09-18.
Kontynuacja zakończonego TODO 22954807-415b-4d06-aa01-2e1e23f524cd.
Status: implementacja M1–M11 i poprawki P2-R1–R6 są w kodzie; TODO 87c5390c pozostaje doing.
Dokończenie odbioru (live health, brakujące M9, klikalne M11): [docs/DELEGATION-MODERNIZATION-PHASE-2B.md](DELEGATION-MODERNIZATION-PHASE-2B.md).
Użytkownik potwierdził restart serwera. Live odczyt health jest w etapie IIb (C1).

## Cel

System ma wyraźnie pokazywać, czy wykonuje i dostarcza zadania, nie tracić zapisów wskutek drugiego procesu, nie blokować wszystkich delegacji przez jednego powolnego odbiorcę i bezpiecznie odzyskiwać stan po rzeczywistym restarcie.

Nie powtarzamy pierwszego etapu: naprawione B1–B9 oraz R1–R8 pozostają bazą regresji. Nie zamieniamy od razu Cretli w system wielu równoległych agentów.

## Podstawa planu — co wiemy

1. W poprzednim etapie test dwóch procesów wykazał utratę zapisów JSON. To potwierdzone ograniczenie. Sam restart go nie usuwa.
2. lib/delegation-store-lock.js zapewnia kolejkę tylko w obrębie procesu. Cały tick i flush obejmują oczekiwanie na mailbox/adapter. Ryzyko blokowania niezależnych zadań wynika z kodu; w tym etapie planowania nie wykonano nowej reprodukcji zawieszonego adaptera.
3. getDelegationRuntimeHealth() istnieje, ale wyszukiwanie w lib/ i server.js nie wykazało podłączenia go do API/panelu użytkownika.
4. server.js uruchamia void reconcileDelegationsOnBoot() i worker niezależnie. Ścieżka boot wymaga osobnego odbioru błędów i gotowości; ochrona timera nie dowodzi ochrony boot.
5. attempts[] i outbox[] są przechowywane w rekordzie delegacji bez retencji; errors[] jest ograniczone do 20 wpisów. API listy zwraca pełne rekordy, a magazyn jest czytany i zapisywany w całości.
6. Loader JSON akceptuje dodatnią wersję schematu bez odrzucenia przyszłej wersji. Potrzebne są jawne migracje i ochrona przed uruchomieniem starszego kodu na nowszych danych.
7. Test Playwright poprzedniego etapu korzysta z prawdziwej karty, fixture handlerów i mock API. Nie jest testem pełnego serwera ani rzeczywistego restartu.
8. Review ma testy narzędzi/polityki, ale nie ma dowodów pełnego przebiegu na live DeepSeek. Nie utożsamiać tych poziomów pokrycia.

## Priorytety i zadania

P1 = najbliższa implementacja; P2 = po zabezpieczeniu pracy i danych; P3 = opcjonalne rozszerzenie. Rozmiar S/M/L jest względny, nie stanowi obietnicy czasu.

### Etap A — działanie po restarcie i ochrona bieżącego wdrożenia

- [ ] M1 / P1 / M — Health workera i odbiór po restarcie.
  Dodać chroniony endpoint diagnostyczny i prostą sekcję statusu: build/wersja, startedAt, lastTickStartedAt, lastTickFinishedAt, nextRetryAt, degraded/code, zaległe wiadomości, najstarsza intencja, liczba uncertain/failed, worker active vs zatrzymany. Rozdzielić liveness procesu od gotowości delegacji; nie ujawniać treści promptów. Dane zakresować zgodnie z uprawnieniami workspace/widget.
  Odbiór: UI odróżnia działający worker od samego działającego serwera, widzi opóźniony tick oraz degraded i recovery. Test zdrowej/zablokowanej/uszkodzonej instancji. Na aktywnym serwerze tylko odczyt i kontrola świeżości; scenariusze awarii na kopii izolowanej.
  Kod: lib/delegation-runtime-worker.js, lib/routes/delegations-routes.js, server.js.
  Zależności: brak.

- [ ] M2 / P1 / M — Kontrolowany start i zatrzymanie delegacji.
  Ujednolicić granicę błędów boot/runtime; jawny stan initializing/ready/degraded. Uzależnić przyjmowanie nowych delegacji od ukończenia niezbędnego recovery, bez blokowania diagnostyki. Przy SIGTERM zatrzymać przyjmowanie nowej pracy, zatrzymać timer, zakończyć krótkie zapisy i utrwalić stan niepewnych uruchomień. Limit czasu shutdown nie może oznaczać sukcesu.
  Odbiór: błąd JSON/I/O podczas boot nie daje nieobsłużonego Promise ani restart-loop bez diagnostyki; SIGTERM podczas start/dispatch nie powoduje cichego powtórzenia pracy po uruchomieniu. Test obejmuje faktyczne procesy serwera.
  Zależności: M1; integracja z M3.

- [ ] M3 / P1 / M — Wymusić jednego właściciela magazynu JSON.
  Chronić katalog danych blokadą właściciela procesu przed pierwszym zapisem, również podczas boot. Drugi writer dostaje czytelną odmowę, nie pozorne powodzenie. Uwzględnić wszystkie zapisujące ścieżki, nie tylko outbox; ustalić kontrakt narzędzi lokalnych/MCP i skryptów. Poprawnie obsłużyć śmierć właściciela i ponowne użycie PID; preferować mechanizm zwalniany przez system, jeśli środowisko go wspiera.
  Odbiór: dwa równoczesne starty na jednym katalogu nie zapisują jednocześnie; SIGKILL właściciela nie zostawia permanentnej blokady; odmowa jest widoczna. Test deterministyczny zamiast uznawania benchmarku wykazującego utratę danych za PASS bezpieczeństwa.
  Zależności: decyzja kontraktu owner w M2. Ochrona tymczasowa, zanim powstanie magazyn transakcyjny.

### Etap B — niezależne dostarczanie i odzyskiwanie

- [ ] M4 / P1 / L — Nie trzymać globalnej kolejki magazynu podczas pracy adaptera.
  Rozdzielić krótką rezerwację intencji, wywołanie adaptera i zapis potwierdzenia. Dodać lease/revision oraz token właściciela chroniący przed spóźnioną odpowiedzią poprzedniego workera. Zachować kolejność per odbiorca i limity liczby dispatch; timeouty i health mają działać również podczas wiszącego startu.
  Odbiór: adapter A nigdy nie rozstrzyga Promise, ale raport do niezależnego B dociera, health się aktualizuje, timeouty nadal działają. Późny accept A nie tworzy drugiego run ani nie potwierdza cudzej próby. Brak utraty intencji przy retry/cancel/restart.
  Kod: lib/delegation-store-lock.js, lib/delegation-runtime-worker.js, lib/delegation-service.js, lib/delegation-mailbox.js.
  Zależności: M1–M3.

- [ ] M5 / P1 / L — Kontrakt przyjęcia promptu i odzyskiwanie uncertain.
  Oddzielić ID wiadomości, próby wysyłki i uruchomienia. Zdefiniować dla każdego adaptera: idempotentny requestId, możliwość sprawdzenia przyjęcia i możliwość anulowania. Jeśli adapter nie umie rozstrzygnąć przyjęcia, utrzymywać uncertain i pokazać użytkownikowi skutki ponowienia. Nie obiecywać exactly-once dla zewnętrznych wywołań bez wsparcia adaptera.
  Odbiór: restart między accept a zapisem runId; odpowiedź utracona w sieci; ręczne ponowienie uncertain; dwa żądania tego samego requestId. Brak automatycznego podwójnego wykonania. Dostarczenie do mailbox, przyjęcie przez model i przegląd wyniku mają osobne znaczenie w API/UI.
  Zależności: M4.

### Etap C — trwałość i rosnąca historia

- [ ] M6 / P2 / L — Zaprojektować i wdrożyć transakcyjne repozytorium delegacji.
  Najpierw krótka decyzja architektoniczna: docelowo jeden host czy wiele instancji. Dla pojedynczego hosta ocenić lokalną bazę transakcyjną, dla wielu hostów wspólny magazyn. Zweryfikować dostępne biblioteki i wersje podczas implementacji; nie wybierać zależności na podstawie tego planu.
  Rozdzielić Delegation, Attempt, Message i OutboxIntent; unikalne klucze idempotencji, raport per próba, status+outbox w jednej transakcji. Indeksy odbiorcy/statusu/nextAttemptAt i repozytorium oddzielone od adapterów.
  Odbiór: testy kontraktu przechodzą na starym i nowym backendzie; 2 i 4 procesy, znany zestaw unikalnych zapisów, zero utraconych rekordów; crash w transakcji nie zostawia połowy operacji. Benchmark z realistycznymi raportami i historią 1k/10k/100k pozycji, p50/p95, pamięć i opóźnienie event loop.
  Zależności: M3–M5. Pierwszy dostarczalny wynik: decyzja i kontrakt repozytorium, potem implementacja.

- [ ] M7 / P1 dla ochrony wersji, P2 dla migracji / M — Schemat, backup i migracja z planem wycofania.
  Odrzucać nieznaną przyszłą wersję zamiast jej cichego przepisywania. Wersjonować dokument i rekordy. Migracja ma mieć dry-run, backup, sprawdzenie liczby/ID/relacji/hash treści, checkpoint i idempotentne wznowienie. Przełączenie writera kontrolowane; wycofanie po nowych zapisach musi zachować te zapisy, nie przywracać bezmyślnie starej kopii.
  Odbiór: migracja pustego/legacy/uszkodzonego magazynu, przerwanie w połowie, ponowienie, stary kod wobec nowego schematu, odtworzenie z backupu. Żadne testy nie używają aktywnego data/.
  Zależności: ochrona wersji od razu; migracja nowej bazy po M6.

- [ ] M8 / P2 / M — Retencja i stronicowanie zamiast pełnych rekordów na każdej liście.
  Lista zawiera zwięzłe podsumowania; historia prób, raport i outbox mają osobne strony/kursory. Dodać archiwizację i limity retencji zakończonych danych. Zachować tombstone klucza idempotencji przez uzgodniony okres, by archiwizacja nie uruchamiała starych zleceń ponownie. Nie usuwać aktywnych, uncertain ani niedostarczonych intencji.
  Odbiór: stabilne strony podczas dopisywania historii, bounded payload list, archiwizacja nie psuje replay/retry, audyt operacji zachowany. Wydajność porównana z bazą M6, bez arbitralnego progu czasu z jednej maszyny.
  Zależności: kontrakt M6/M7; API można przygotować wcześniej.

### Etap D — pełna walidacja i obsługa

- [ ] M9 / P1 / L — E2E całego serwera i prawdziwe restarty.
  Uruchamiać osobną instancję Cretli z odrębnym portem/katalogiem danych, rzeczywistymi trasami, WebSocket i adapterem testowym. Utrzymać test fixture karty jako szybki test komponentu.
  Odbiór: create → run → report → ack, retry, zajęty rodzic, dwa cykle pytań, reconnect przeglądarki, SIGTERM/SIGKILL podczas start/accept/history/mailbox, recovery i kontrola liczby uruchomień. Izolowany test produkcyjnego trybu obsługi błędów. Testy nie mogą połączyć się z przypadkowo działającym serwerem ani odziedziczyć aktywnego data/.
  Zależności: harness na początku; kompletna macierz po M2–M5.

- [ ] M10 / P2 / M — Macierz możliwości adapterów i użyteczny review.
  Jawne capabilities: odczyt plików, wyszukiwanie, odmowa mutacji, cancel, rekonstrukcja sesji, lookup requestId. Testować faktyczną ścieżkę adaptera z kontrolowanym SDK, nie wyłącznie helper policy. Podłączyć UI do tej macierzy zamiast zakładać równość harnessów.
  Odbiór: każdy włączony harness potrafi w review przeczytać fixture repo i zwrócić raport; próba zapisu jest zablokowana, pytanie i cancel działają. Osobno oznaczać unit/integration/live. Live na wybranych modelach dopiero w ramach jawnie ustalonego budżetu testów; brak live nie udaje pełnej certyfikacji.
  Zależności: M5/M9. Koordynacja z istniejącym TODO dotyczącym sesji DeepSeek; nie dublować jego zmian.

- [ ] M11 / P2 / M — Centrum delegacji i świadome operacje naprawcze.
  Widok workspace: aktywne, wymagające odpowiedzi, failed, uncertain, czekające na dostarczenie. Oś prób i wiadomości z odsyłaczami do oryginalnego zadania, modelu, artefaktów i błędów. Rozróżnić „ponów zadanie” od „ponów dostarczenie”. Operacje pokazują skutek i bieżący status; zduplikowane kliknięcia są idempotentne.
  Odbiór: użytkownik ustala, co utknęło i jaka operacja jest bezpieczna; filtr nie ujawnia obcego workspace/widget; dostępność klawiaturą, polskie/angielskie komunikaty, mobilny layout. Test na prawdziwych trasach M9.
  Zależności: M1/M5/M8.

### Etap E — opcjonalnie, po zakończeniu podstaw

- [ ] M12 / P3 / L — Kontrolowana pula wykonawców.
  Tylko po M3–M10: limity globalne/workspace/rodzic, proste zależności zadań, agregacja raportów, anulowanie grupy. Izolować implementacje w worktree lub innym osobnym katalogu; scalenie przez sprawdzalny diff. Rozdzielić limit aktywnych prób od liczby wiadomości.
  Odbiór: zadania zależne nie startują za wcześnie, awaria jednego nie gubi reszty, limity są respektowane, konflikty plików nie są automatycznie nadpisywane. Zmiana modelu lub zwiększenie kosztu jest jawne. Bez spełnienia wcześniejszych bramek pozostaje planem opcjonalnym, nie blokuje odbioru etapu II.

## Kolejność dostaw i bramki

1. Dostawa A: M1, M2, M3 oraz ochrona wersji M7. Równolegle przygotować harness M9. Bramka: widoczny stan po restarcie, kontrolowany boot, brak drugiego writera.
2. Dostawa B: M4–M5 i restartowa macierz M9. Bramka: zawieszony adapter nie zatrzymuje niezależnych delegacji; niepewny accept nie prowadzi do automatycznego duplikatu.
3. Dostawa C: decyzja M6 → migracja M6/M7 → M8. Bramka: testy konkurencji i odtwarzania, bez utraty rekordów. Jeśli baza zostaje odroczona, zapisać to jako otwarty zakres, a nie oznaczać M6/M7 jako wykonane.
4. Dostawa D: M10–M11 oraz końcowe E2E. Bramka: rzeczywiste możliwości adapterów i obsługa przez UI sprawdzone na izolowanej instancji.
5. M12 jest osobną decyzją produktową po wynikach A–D.

## Zasady odbioru

Każda dostawa: diff, testy, konkretne dowody spełnienia kryteriów, migracja/rollback i lista ograniczeń. Zachować 18 zestawów regresyjnych poprzedniego etapu i test komponentu karty; rozszerzać testy o nowe zachowania, nie zastępować testów atrapami deklarującymi sukces.

Nie oznaczać całego TODO done po samym dodaniu endpointu, samej symulacji crash ani pojedynczym benchmarku. Status wdrożenia i weryfikacji aktywnego serwera raportować osobno od statusu implementacji. Nie restartować aktywnej aplikacji ani nie uruchamiać płatnych zadań w ramach przygotowywania tego planu.

