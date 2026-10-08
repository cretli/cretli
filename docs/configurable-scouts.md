# Konfigurowalne Scouty i własne zadania

Status: projekt do wdrożenia. TODO: 7acf66ec-d231-4c94-9492-aef8ac00f600.

## Cel i obecny stan
Umożliwić konfigurowanie Scoutów oraz tworzenie własnych Scoutów do różnych zadań, bez zmiany ich roli: Scout analizuje workspace i proponuje pracę, a realizacja pozostaje w TODO/Watcherze.

Obecnie istnieje jeden Scout workspace z predefiniowanym promptem i sześcioma kategoriami: bug, improvement, refactor, security, opportunity, documentation. Można już ustawiać harmonogram, budżet, dozwolone harnessy i kategorie; brakuje osobnych nazwanych profili, własnych instrukcji, zakresu i historii dla każdego zadania. Kategorie klasyfikują wynik i nie powinny pełnić roli definicji Scouta.

## Projekt funkcjonalności

### 1. Profile i szablony
Workspace posiada listę niezależnych profili Scoutów. Profil opisuje zadanie, np. „Regresje płatności”, „Wydajność zapytań”, „Dostępność UI”, „Porządkowanie dokumentacji”, „Refaktoryzacja dużych modułów”.

Użytkownik może:
- utworzyć Scouta od zera;
- utworzyć profil z szablonu: ogólny, błędy, bezpieczeństwo, refaktoryzacja, dokumentacja, wydajność;
- edytować i duplikować profil, włączać/wyłączać, uruchamiać ręcznie i archiwizować;
- przywrócić instrukcje szablonu po pokazaniu różnic i potwierdzeniu nadpisania.

Szablon jest punktem startowym. Profil przechowuje kopię konfiguracji; aktualizacja szablonu nie nadpisuje zmian użytkownika. Szablony oraz profile własne uruchamiają się tą samą ścieżką. Nowy profil ma `schedule=manual` i `enabled=false`. Pole `enabled` w profilu włącza automatyczne skany; ręczny start niearchiwalnego profilu jest dostępny również przy `enabled=false`, o ile pozwalają na niego globalne bramki workspace. UI opisuje ten przełącznik jako „Automatyczne skany”.

### 2. Konfiguracja profilu
Pola:
- id, revision, name, description, enabled, archivedAt;
- templateId/templateVersion — opcjonalne pochodzenie;
- objective — cel zadania;
- instructions — własne instrukcje, przykłady dobrych wyników i kryteria odrzucenia;
- scope: include/exclude globs względem workspace; tryb analizy „zmiany względem wskazanej bazy Git” albo „wskazany obszar workspace”; domyślnie main bez fallbacku dla jawnej bazy; tylko wartość auto wybiera kolejno main, master, HEAD, z widoczną diagnostyką;
- sources: diff, historia Git, markery TODO/FIXME, zapisane wyniki testów, logi; istniejące TODO, poprzednie findings i Workspace Memory pozostają obowiązkowym kontekstem deduplikacji;
- categories — niepusta lista z obecnych sześciu kategorii; własna nazwa zadania nie wymaga nowej kategorii;
- executor: automatyczny wybór albo jawny harness/model oraz opcjonalne zawężenie dozwolonych harnessów;
- schedule: manual albo intervalHours;
- limits: maxPerDay, maxFindingsPerScan, timeout; wspólna polityka workspace wyznacza limity nadrzędne.

Walidacja: wymagane name/objective, ograniczone długości tekstu i liczby profili, poprawne globs/limity/harmonogram, niepuste kategorie i dostępny executor. Pusta lista dostępnych kategorii lub executorów blokuje start z czytelnym powodem, zamiast rozszerzać zakres do wszystkich. Brak wyników dopasowania plików daje „brak plików w zakresie”, a nie skan całego repozytorium.

### 3. UI
Settings → Workspace Watcher → Scout:
- lista profili z nazwą, celem, stanem, ostatnim/następnym uruchomieniem, wykorzystanym limitem i liczbą propozycji;
- akcje „Nowy Scout”, „Z szablonu”, „Edytuj”, „Duplikuj”, „Uruchom teraz”, „Włącz/Wyłącz”, „Archiwizuj”;
- formularz z podstawowymi polami: nazwa, cel, instrukcje, zakres, częstotliwość; źródła, executor i limity w ustawieniach zaawansowanych;
- podgląd efektywnej konfiguracji i promptu oraz plików objętych zakresem przed uruchomieniem;
- historia skanów wybranego profilu: status, czas, model, zużycie jeśli dostępne, liczba propozycji i powód błędu/blokady;
- wspólna skrzynka propozycji z filtrem Scouta/kategorii/statusu; na propozycji i powstałym TODO widoczny Scout oraz skan źródłowy.

Przykład: utwórz z szablonu „Wydajność”, nazwij „Zapytania zamówień”, ustaw lib/orders/** i instrukcję „Szukaj N+1 i brakujących indeksów; każda propozycja ma wskazać zapytanie i sposób pomiaru”, uruchom ręcznie, przejrzyj propozycje, dopiero potem włącz skan co 24 h.

### 4. Wykonywanie i harmonogram
Każdy profil ma własny lastRunAt, nextRunAt, licznik dzienny UTC, historię i stan aktywnego skanu. Scheduler na obecnym heartbeacie wybiera należne włączone profile w uczciwej kolejności, tak aby częściej uruchamiany profil nie zagłodził innych.

Nadrzędne pozostają obecne: tryb Watchera, global pause/stop, quiet hours, scoutEnabled, scoutMaxPerDay i scoutMaxParallel. Skan musi spełnić zarówno limit profilu, jak i workspace. Skan i jego review liczą się do wspólnego limitu Scoutów, poza slotami wykonania TODO. MVP: najwyżej jeden aktywny skan danego profilu.

„Uruchom teraz” działa również dla profilu bez automatycznego harmonogramu; pomija tylko odstęp czasu. Nadal respektuje globalne blokady i limity oraz nie włącza harmonogramu. Profil archiwalny nie może wystartować. Rezerwacja slotu i obu liczników jest atomowa; nieudany start zwalnia rezerwację według obecnej semantyki. Restart serwera nie resetuje limitów ani nie uruchamia drugi raz tego samego skanu.

Rozpoczęty skan zapisuje snapshot konfiguracji i revision; edycja wpływa na kolejne skany. Wyłączenie automatycznych skanów blokuje przyszłe starty z harmonogramu, archiwizacja blokuje również ręczne starty. Aktywny skan może zakończyć się na swoim snapshotcie. Historię i propozycje zachowujemy.

### 5. Prompt, wyniki i integracja TODO
Prompt składa się z niezmiennego kontraktu Scouta, konfiguracji profilu i snapshotu sygnałów. Własne instrukcje określają cel i sposób oceny; nie znoszą kontraktu tylko do odczytu, reguł narzędzi, limitów ani schematu odpowiedzi. Zachować techniczny start `sdkMode=agent`/`mode=agent`, używany przez obecny runner dla zgodności harnessów; opis roli nie może twierdzić, że transport jest w Plan mode. Dane repozytorium/logów pozostają niezaufanym kontekstem. Sam prompt ani tryb agent nie są egzekwowaniem zakazu zapisu — politykę Scouta trzeba stosować przed wykonaniem narzędzi niezależnie od trybu transportu (szczegóły poniżej).

MVP zachowuje obecne findings: title, category, rationale, files[]; rationale ma zawierać dowód, wpływ i proponowany sposób weryfikacji. Serwer przypisuje scoutId/scoutRevision/scanId, czas i dane executora ze skanu, nie z deklaracji modelu. Submit wymaga aktualnego tokenu skanu powiązanego z profilem i chatem.

Deduplikacja działa w obrębie całego workspace, także pomiędzy profilami, wobec istniejących TODO, propozycji i wcześniejszych decyzji. Nakładające się wyniki aktualizują informację o źródłach zamiast tworzyć kolejne TODO. „Obszar zbadany” w pamięci wiązać z celem/zakresem i rewizją kodu lub TTL, żeby audyt dokumentacji nie blokował audytu bezpieczeństwa ani nowych zmian.

Zachować aktualny opt-in przechwytywania wyników przez serwer: przy `scoutAutoCreate=true` zapis nowych wyników może automatycznie zaakceptować propozycje i utworzyć idempotentnie TODO `idea` z niezatwierdzonym planem; dla skanu zachować istniejące grupowanie wyników. Przy `false` przechowujemy propozycje do ręcznej decyzji, bez samoczynnego tworzenia TODO. Ponowny submit/accept lub drugie źródło nie tworzą drugiego TODO ani pustej grupy. To ustawienie użytkownika upoważnia serwer do przechwycenia pomysłów; agent skanu nie wywołuje narzędzi tworzenia TODO. Profil nie może zatwierdzić planu, oznaczyć zadania ready ani uruchomić implementacji. Rationale i istniejący opcjonalny `plan_markdown`/`planMarkdown` zachować zgodnie z obecnym parserem; plan pozostaje szkicem. Zmiana bieżącej semantyki autoCreate nie jest celem funkcji profili.

Zakres plików stosować przy zbieraniu kontekstu i walidacji wyników; wykluczone pliki nie trafiają do findings. Globs nie są granicą izolacji procesu harnessu — egzekwować kontrakt tylko do odczytu w polityce narzędzi Scouta, bez utożsamiania go z Plan mode. Dowolne komendy shell nie są polem własnych instrukcji; istniejący opt-in test probe pozostaje oddzielnie kontrolowaną opcją workspace.

### 6. Dane, API i zgodność
Rozszerzyć istniejący store Watchera o wersjonowaną kolekcję scoutProfiles i stan/historię per profil; wspólny budżet oraz pendingScoutFindings pozostają na poziomie workspace. Active scans muszą przechowywać profil, snapshot i dotychczasowy cykl życia/tokeny/archiwizację chatów.

API/UI/MCP: lista i odczyt profili, CRUD/duplikacja/archiwizacja, podgląd konfiguracji, uruchomienie po scoutId, historia i filtrowanie findings. Konfiguracja profili korzysta z obecnych uprawnień ustawień Watchera; agent skanu nadal ma tylko dozwolone list/submit. Aktualizacje konfiguracji wymagają kontroli revision/CAS. Istniejące endpointy /api/workspace-watcher/scout i narzędzie MCP `scout_findings` (dawniej `watcher_scout_findings`) rozszerzyć bez łamania dotychczasowych klientów.

Migracja idempotentna: z istniejącej konfiguracji powstaje JEDEN profil „Scout ogólny” odwzorowujący dotychczasowy prompt, kategorie, źródła, harmonogram, limity i harnessy. Zachować stan włączenia, zużyte budżety, aktywny skan, propozycje i ich statusy; stare dane bez scoutId przypisać do profilu ogólnego. Nie tworzyć automatycznie sześciu działających skanów. Legacy run bez scoutId kieruje do profilu ogólnego; historyczne pola konfiguracyjne obsługiwać przez jawny adapter, bez dwóch niezależnych źródeł prawdy. Nowe workspace dostają wyłączony profil ogólny i dostęp do szablonów.

## Zakres MVP i później
MVP: profile per workspace, szablony, własne instrukcje i zakres, źródła, ręczne uruchomienie i interwał, executor, limity, historia, wspólne findings/TODO oraz migracja.
Później: import/eksport wersjonowanych profili bez stanu skanów i sekretów, biblioteka między workspace, wyzwalacze zdarzeniowe (np. zmiana kodu), własne schematy raportów. Scout realizujący zmiany w kodzie pozostaje poza tą funkcjonalnością.

## Etapy wdrożenia
1. Model profili, walidacja, CAS i migracja istniejącego Scouta.
2. Składanie promptu, wybór/ograniczanie źródeł i zakresu, szablony i podgląd.
3. Scheduler per profil z atomowym wspólnym budżetem, restartem i snapshotami.
4. API/MCP, historia, atrybucja/deduplikacja wyników i integracja TODO.
5. UI w trzech kolejnych podzadaniach: lista i akcje; edytor/szablony/podgląd; historia/propozycje. Każde obejmuje PL/EN i dostępność swojego widoku.
6. Regresje, dokumentacja docs/workspace-watcher.md i rollout.

Główne miejsca: lib/workspace-watcher-scout.js, lib/persist/workspace-watchers-persist.js, lib/workspace-watcher-control.js, lib/routes/workspace-watcher-routes.js, lib/mcp/builtin/watcher-tools.js, lib/mcp/mcp-inprocess-client.js, lib/remote-api-client.js, app_front/features/settings/workspaceWatcherSettings.js, app_front/features/watcher/watcherPanel.js oraz istniejące testy Scouta/Watchera.

## Kryteria odbioru
- Utworzenie dwóch własnych profili o różnych celach i zakresach; niezależne uruchomienia, prompt, harmonogram i historia.
- Edycja/duplikacja szablonu nie zmienia innych profili; snapshot trwającego skanu pozostaje niezmienny.
- Poprawne współdzielenie budżetu i limitu równoległości; pause/quiet hours/stop blokują również ręczne starty; żaden Scout nie zajmuje slotu TODO.
- Brak podwójnego startu przy równoległym kliknięciu/heartbeacie; restart i nieudany start nie psują liczników.
- Wyniki spoza zakresu oraz niepoprawny submit/token są odrzucane; własny prompt nie rozszerza uprawnień.
- Ten sam problem wykryty przez dwa profile daje jedną propozycję/TODO ze źródłami.
- Akceptacja pozostawia istniejące zasady idea/niezatwierdzony plan; nie uruchamia implementacji.
- Migracja ponowiona nie duplikuje profilu ani skanów i zachowuje bieżącą konfigurację, historię, limity oraz istniejących klientów.
- Testy regresji obejmują realne scenariusze współbieżności, migracji, restartu, deduplikacji, zakresu i uprawnień; istniejące testy Scouta/Watchera przechodzą.

## Doprecyzowania po audycie DeepSeek i weryfikacji kodu

Audyt 2026-10-06: delegacja `2dd5a932-0c59-48d9-a522-fd9f14503b6b`, DeepSeek V4.1 Flash. Pierwotny plan otrzymał FAIL; poniższe decyzje uzupełniają projekt. Weryfikacja rodzica: [raport](configurable-scouts-review.md). Dotyczą przyszłej implementacji, nie stanowią deklaracji gotowości nowych funkcji.

### Model skanów i działające etapy pośrednie (kroki 1 i 3)

- Kolekcja `activeScoutScans` identyfikowana po `scanId`, z `scoutId` i snapshotem revision; najwyżej jeden nierozliczony start na profil. Stare `activeScoutScan` migrować z zachowaniem tokenu, chatu i czasu wygaśnięcia. Schemat store podnieść z v1 do v2.
- Przepiąć rezerwację/start, autoryzację submit, autofill tokenu w MCP, clear/expire, heartbeat, boot reconciliation, archiwizację i `workspaceWatcherScoutParentChatIds`. Usunięcie po `scanId` może usunąć wyłącznie wskazany skan; chat identyfikuje swoje własne credentials.
- Zajętość wspólna obejmuje rezerwacje jeszcze bez chatu oraz żywe/niepewne skany i ich review. Łączyć ją ze snapshotem chatów/delegacji, bez podwójnego liczenia; zachować lineage również po wyczyszczeniu tokenu, dopóki review zajmuje slot. Sprawdzenie limitu i dodanie rezerwacji pod tym samym lockiem.
- Rollback rozlicza własną rezerwację jeden raz. Nie przywraca całego poprzedniego licznika ani lastRunAt workspace: nieudany A nie może cofnąć zużycia udanego B. Brak przyjęcia startu jest koniecznym, ale nie wystarczającym warunkiem refundu. Zachować rozróżnienie: normalny `started=false` (np. brak executora/odmowa utworzenia chatu) konsumuje slot harmonogramu i limit dzienny, lecz zwalnia zajętość równoległą; throw z potwierdzonym brakiem przyjęcia oraz `global_starts_disabled` refundują raz. Niepewny start zachowuje zajętość do reconciliation, a wygaśnięcie tokenu samo nie dowodzi zakończenia procesu. Rozliczenie uwzględnia dzień rezerwacji i przejście UTC. Tabela rozliczeń po recenzji Grok poniżej rozstrzyga również crash rezerwacji.
- Po kroku 1 nadal działa dotychczasowy ogólny Scout. Do czasu ukończenia kroku 4 (autoryzacja i zapis wyników wielu profili) nowe równoległe profile nie mogą uruchamiać się w produkcji; krok 3 jest sprawdzany z izolowanymi fixture'ami. Test działającego legacy przepływu po każdym etapie.

### Wyniki, wiele źródeł i retencja (kroki 1 i 4)

- `sources[]` obejmuje serwerowo ustalone `scoutId`, `scoutRevision`, `scanId`, `chatId`, `runId`, executor i czas. Normalizacja danych przechowywanych zachowuje te pola; niezaufany submit nie może ich sam ustawić. Historyczne `source` migrować tylko na podstawie dostępnych danych, bez wymyślania brakujących identyfikatorów.
- Deduplikacja i zapis/merge wykonują się atomowo wobec aktualnego store. Dwa równoczesne submit tego samego problemu nie mogą oba utworzyć nowej propozycji. Powtórzone źródło jest idempotentne. Dopisanie źródła zachowuje ID, status i decyzję użytkownika; nie otwiera ponownie rejected/accepted i nie tworzy drugiego TODO. Akceptacja sprawdza istniejące TODO w tym samym chronionym przepływie. Historię źródeł stronicować i wiązać ze skanami.
- Zachować globalny limit 200 nierozpatrzonych propozycji, ale nie usuwać najstarszych pending. Przy pełnej skrzynce nowe unikalne findings odrzucać z jawnym `capacity_exceeded` i liczbą odrzuconych w wyniku/historii skanu; merge istniejącego findingu pozostaje dozwolony. Rozpatrzone decyzje przenosić do osobnej historii; retencja decyzji i związków z istniejącymi TODO nie może po cichu reaktywować odrzuconych pomysłów. Normalizator/migracja nie mogą utracić pending przez `slice(-200)`.
- Model historii od kroku 1: `scanId/scoutId/revision`, start/koniec, status (`reserved`, `running`, `completed`, `failed`, `interrupted`, `uncertain`), executor, liczby added/merged/dropped i powody, błąd oraz referencje chat/run. Usage wiązać z istniejącym ledgerem, brak pomiaru oznaczać `null`, nie zero. Publiczna historia/podgląd nie ujawnia submitToken.
- Retencja szczegółów zakończonych skanów: ostatnie 100 na profil, maksymalnie 1000 na workspace. Aktywne/uncertain nie podlegają czyszczeniu. Po usunięciu szczegółów zachować minimalne źródło przy finding/TODO. Retencja decyzji użytkownika i źródeł jest oddzielna od tej historii.

### Wybór executora, walidacja i zgodność (kroki 1–4)

- Puste `scoutCategories` w legacy oznaczały wszystkie kategorie; migracja materializuje ten zestaw. Nowe profile odrzucają pusty zbiór. Analogicznie odróżnić brak dodatkowego ograniczenia harnessów od pustego wyniku przecięcia dozwolonych zbiorów.
- Nadrzędny zbiór Scoutów to niepuste `scoutAllowedHarnesses`, a przy jego braku obecny fallback `allowedHarnesses`; nie zmieniać tej historycznej semantyki na przecięcie obu. Profil może ten zbiór jedynie zawęzić. Dodatkowo obowiązują enabled/ready/can_delegate, ulubione modele i rzeczywiste usage limits. Efektywnie pusty zbiór blokuje start.
- Jawny harness/model profilu ma pierwszeństwo przed odziedziczonym `policy.orchestrator`; musi przejść powyższe bramki i nie otrzymuje cichego fallbacku. Tryb auto nowego profilu wybiera spośród dopuszczonych modeli i nie dziedziczy executora cykli TODO. Migracja ogólnego profilu zapisuje dotychczasowy jawny wybór orkiestratora, jeśli istnieje, aby zachować zachowanie. Niekompletny legacy wybór (sam harness) zachowuje dotychczasowe rozwiązywanie modelu przez adapter.
- Przepiąć wszystkie odczyty `policy.scout*` w signals/prompt/runner/eligibility/action/settings na konfigurację efektywną; pozostawić wyraźnie globalne bramki i budżety. Podgląd pokazuje pochodzenie ustawień i blokady.
- Odczyt nowego workspace pozostaje bez zapisów: zwraca wirtualny, wyłączony profil ogólny o deterministycznej tożsamości. Trwały profil/wiersz tworzyć przy jawnej konfiguracji. Migracja istniejących wierszy nie resetuje stanu; test repeated read bez zapisu.
- Wspierana jest zgodność klientów REST/MCP, nie równoczesny zapis store przez stare i nowe serwery. Rollout: kopia danych, zatrzymanie nowych startów i starego writera, migracja jednym writerem, sprawdzenie legacy. Powrót do v1 tylko przez odtworzenie kopii danych po zatrzymaniu v2; pojedynczy mirror nie reprezentuje wielu skanów i nie gwarantuje downgrade.

### Dodatkowe kryteria odbioru

- A i B działają równolegle: oba mogą submitować, zakończenie/expiry A nie usuwa B; autofill MCP nie ujawnia tokenu innego chatu; review nadal zajmuje właściwy slot.
- Failed start A, successful B i reset UTC nie gubią liczników; dwa starty z jednego heartbeat respektują atomowy limit.
- Równoczesne duplikaty dają jedną propozycję i dwa źródła; retry nie dopisuje trzeciego; merge zachowuje decyzję accepted/rejected.
- 201. unikalne finding nie usuwa pierwszego pending; wynik pokazuje overflow; czyszczenie historii nie usuwa aktywnych skanów ani atrybucji TODO.
- Ręczny skan jest możliwy przy wyłączonej automatyce profilu, ale globalny stop/quiet hours/limit nadal go blokuje; archiwalny profil nie startuje.
- Jawny executor, auto, legacy override, brak favorites i puste przecięcie mają jednoznaczne wyniki zgodne z precedencją; żaden etap pośredni nie udostępnia niekompletnego przepływu.

## Doprecyzowania po recenzji Grok 4.7

Recenzja `5c4094de-c373-434c-9aa8-c77d11d4842a` dotyczyła wersji po DeepSeek i zakończyła się FAIL. Rodzic potwierdził uwagi w aktualnym kodzie; [raport Grok i weryfikacja](configurable-scouts-grok-review.md). Poniższe obowiązki uszczegóławiają podział etapów; nie wolno odkładać zgodności legacy do późniejszego etapu.

### Krok 1: przejście storage i wszystkich konsumentów w jednej zmianie

Wprowadzenie `activeScoutScans` wymaga w tym samym etapie przepięcia wszystkich odczytów/zapisów singletona: reserve/set, submit i clear, expire, MCP autofill w `lib/mcp/mcp-inprocess-client.js`, parent IDs, boot, archive oraz `getWorkspaceWatcherRuntimeStatus` w `lib/workspace-watcher-runtime-control.js`. Centralne get/set/clear po `scanId`/`chatId` są częścią kroku 1, nie dopiero kroku 4. Do ukończenia kroku 4 produkcyjny runner korzysta tylko z migrowanego profilu ogólnego; sama zmiana reprezentacji nie aktywuje dodatkowych profili.

Legacy adapter importuje stary singleton i dostarcza nowym konsumentom kolekcję bez utraty credentials. Normalizacja kolejnego mutate nie może wyciąć tokenu pozostawionego przez stary call-site; akceptacja kroku 1 obejmuje prawdziwy legacy start → zapis → MCP autofill → submit → clear, także po restart. Kod wewnętrzny przestaje zapisywać singleton w tym samym wdrożeniu; nie utrzymujemy dwóch niezależnych writerów. Krok 4 rozszerza API/atrybucję/wieloprofilowość, nie naprawia bazowego dostępu do stanu wprowadzonego wcześniej.

### Krok 3: deadline, reconciliation i drain

- Rekord rezerwacji zawiera trwałe `attemptId`, `ownerInstance`, `reservedAt`, `startDeadlineAt` (120 s jak deadline startu cyklu, oddzielny od TTL submitu), informację `launchIssued` i `acceptedAt`, oraz przydzielone `chatId`/`requestId` przed przekazaniem startu do harnessu. Efekty zewnętrzne następują po zapisie tożsamości próby. `launchIssued` jest znacznikiem możliwości startu, nie dowodem, że proces istnieje.
- `reserved`, aktywne i `uncertain` zajmują slot aż do rozliczenia. Przed deadline żywego właściciela nie zwalniać rezerwacji. Po deadline: jeśli potwierdzono śmierć właściciela/brak in-flight próby i nie wydano zewnętrznego startu, oznaczyć `failed` i refundować raz. Sam timeout lub brak `chatId` nie jest takim potwierdzeniem.
- Po `launchIssued` probe chatu, requestId/runu, procesu i delegacji/review ustala busy/idle/unknown. Busy albo unknown pozostają zajęte; unknown blokuje ponowny start profilu i wymaga reconciliation lub jawnej interwencji. Brak chatu nie wystarczy, jeśli start mógł zostać wydany. Potwierdzony idle/brak procesu bez review zwalnia slot; rozpoczęty, niezakończony skan oznaczyć `interrupted` bez refundu przyjętego startu. Zakończony z poprawnym submit pozostaje `completed`.
- Jeśli zewnętrzny start mógł zostać przyjęty, a odpowiedź/acceptedAt nie dotarły, wynik jest `uncertain`; nie ponawiać automatycznie ani nie refundować tylko na podstawie throw. Kontynuacja po restarcie korzysta z durable attempt, nie tworzy nowej próby, dopóki stara nie jest rozliczona.
- Expiry odbiera możliwość submit tylko temu scanId, ale zajętość zależy od liveness i review. Reconciliation działa na boot i heartbeat, również przy wyłączonych startach/automatyce, pause i mode off, tak aby drain mógł się zakończyć. Stan błędu probe/store ustawia `statusUnavailable`; nie jest zgodą na restart.
- `readyForRestart` wymaga globalnego startsEnabled=false, braku rezerwacji/in-flight/unknown/żywych skanów i review oraz dostępnych danych. Nie wyznaczać go wyłącznie z `expiresAt`; używa tego samego predykatu zajętości co scheduler. Minimalna implementacja wsparcia kolekcji jest w kroku 1, komplet lifecycle w kroku 3.

| Wynik próby | Budżet profilu/workspace | Slot równoległy |
| --- | --- | --- |
| Normalne started=false (brak modelu, odmowa utworzenia chatu) | Zużyty, jak obecnie; brak pętli co heartbeat | Zwolniony |
| Global starts disabled lub throw z potwierdzonym brakiem przyjęcia | Refund własnej rezerwacji raz | Zwolniony |
| Crash rezerwacji bez launchIssued, właściciel martwy, deadline minął | Refund raz | Zwolniony |
| Start przyjęty, późniejszy błąd lub interrupted | Zużyty | Do potwierdzenia idle i końca review |
| Timeout/throw po możliwym handoff, busy/unknown | Bez refundu do ustalenia wyniku | Zajęty |

### Krok 2: tryb startu a uprawnienia

Obecny transport startuje w agent mode; wyjątek list/submit w katalogu Plan/Ask nie nakłada ograniczeń na agent mode (`denyMutatingBuiltinTool` zwraca zgodę dla agent). Dlatego nie wystarczy skopiować allowlisty Plan i twierdzić, że już chroni Scouta. Krok 2 ma wprowadzić hostową politykę read-only Scouta niezależną od SDK mode: blokada zapisu/edycji, poleceń zmieniających workspace, delegacji, ustawień i mutujących MCP przed wykonaniem; dozwolone są odczyty i uwierzytelniony submit do własnego skanu. Serwerowe przechwycenie TODO za opt-in autoCreate pozostaje osobnym uprawnieniem backendu.

Zachować `agent` dla zgodności startu, usunąć fałszywe stwierdzenie „running in PLAN mode” z przyszłego promptu/dokumentacji. Jeśli harness nie potrafi egzekwować polityki tylko do odczytu, jest niedostępny dla konfigurowalnych profili z czytelnym powodem; sam prompt nie jest zabezpieczeniem. Wszystkie drogi startu i MCP muszą dostać politykę od zaufanego hosta, nie z argumentów modelu/profilu. Sprawdzenie mutujących działań należy do kryteriów kroku 2 i odbioru, zanim włączymy własne instrukcje w produkcji.

### Dodatkowe kryteria i aktualny stan testów

- Po kroku 1 skan rozpoczęty przed migracją nadal może submitować; drain widzi nową kolekcję; po pierwszym mutate token nie ginie.
- Crash przed handoff, opóźniony handoff, utrata odpowiedzi po przyjęciu, brak chatu/unknown oraz expired-but-busy mają osobne testy; znany failed start nie powoduje pętli retry, niepewny nie uruchamia nowej próby.
- Drain przy pause/off/wyłączonych startach doprowadza potwierdzone idle do zwolnienia slotu; unknown/review/błąd store nigdy nie daje readyForRestart.
- Próba edycji pliku, mutującego MCP lub delegacji przez własne instrukcje jest blokowana przed wykonaniem także przy technicznym agent mode. Odczyt i submit pozostają możliwe.
- Aktualny test bazowy ma FAIL w `tests/workspace-watcher-scout.test.js:465`: kod working tree automatycznie przechwytuje wyniki przy autoCreate już w `recordScoutFindings`, a test oczekuje utworzenia TODO po późniejszym accept. Krok 4 ma zachować aktualną semantykę opt-in i uzgodnić parser/plan szkicu/grupowanie/fixture'y; krok 6 nie może uznać starego historycznego PASS za bieżący wynik. Nie poprawiano kodu ani testu w ramach recenzji planu.

Projekt zapisany do backlogu; implementacja jest osobnym zadaniem.

## Status odbioru (krok 6)

Kroki 1–5 są zaimplementowane w drzewie `next/2026-09-28`; schemat store podniesiono
do `WORKSPACE_WATCHERS_SCHEMA_VERSION = 2` (leniwa normalizacja v1→v2: kolekcja
`scoutProfiles` z jednym profilem ogólnym z migracji, `activeScoutScans` per `scanId`,
mapa `scoutSchedules`, log `scoutScanHistory`). Bramka wieloprofilowości w produkcji
jest otwarta po ukończeniu kroku 4; nowy profil domyślnie `schedule=manual` i
`enabled=false`, więc wdrożenie nie uruchamia samoczynnie nowych profili ani realizacji
TODO.

Uwaga: wcześniejszy akapit „Projekt zapisany do backlogu” oraz wskazany FAIL w
`tests/workspace-watcher-scout.test.js:465` dotyczą stanu przed etapami. Baseline
autoCreate został uzgodniony w kroku 4 i ponownie sprawdzony w kroku 6 — test `:440`
teraz asserts aktualną semantykę opt-in (`record` przechwytuje wynik jako `accepted` i
tworzy TODO `idea` z niezatwierdzonym planem tylko przy `scoutAutoCreate=true`; przy
`false` wynik pozostaje `pending` bez samoczynnego TODO).

Tabela rozliczeń (refundów) w sekcji „Doprecyzowania po recenzji Grok 4.7” istnieje i
jest zgodna z kodem: normalne `started=false` (brak orkiestratora / odmowa utworzenia
chatu) zachowuje rezerwację i konsumuje licznik dnia profilu+workspace, zwalniając
wyłącznie slot równoległy (`lib/workspace-watcher-scout.js`, gałąź `else` przy
`job.started === false`); `global_starts_disabled` oraz throw z potwierdzonym
nieprzyjęciem refundują raz. Pokrycie:
`tests/workspace-scout-schedule.test.js` (m.in. „a normal started=false consumes the
profile and workspace daily budget (refund table)”, „failed start A refunds its own
profile counter and never touches a successful B”, „crash before handoff … refunds
exactly once”).

Jedyna pozostała niezgodność (nie blokuje odbioru): martwy helper `buildScoutPrompt`
(`lib/workspace-watcher-scout.js:1268`) nadal zawiera linię „You are running in PLAN
mode”. Nie jest ona używana w produkcji — runner profili korzysta z
`buildScoutPromptForProfile`, który zgodnie z §5 stwierdza „Read-only contract
(enforced by the host, not by this prompt)” i nie twierdzi, że transport jest w Plan
mode. Wyrzucenie martwego helpera i zaktualizowanie powiązanego assertionu
`tests/workspace-watcher-scout.test.js:234` (`/PLAN mode/`) wymaga zmian w `lib/**` i
jest poza zakresem tego leafa — zgłoszone jako finding w
`docs/configurable-scouts-acceptance.md`.

Pełny raport pokrycia kryteriów: [`configurable-scouts-acceptance.md`](./configurable-scouts-acceptance.md).
