# Recenzja planu przez Grok 4.7

Data: 2026-10-06. TODO: `7acf66ec-d231-4c94-9492-aef8ac00f600`.
Delegacja: `5c4094de-c373-434c-9aa8-c77d11d4842a`, Cursor SDK / Grok 4.7 (256k, medium).

## Wynik i weryfikacja rodzica

Grok ocenił plan po poprawkach DeepSeek jako **FAIL**: pozostała luka w etapowym przejściu na kolekcję skanów i w zwalnianiu rezerwacji. Rodzic przeczytał pełny raport, sprawdził kod oraz wykonał host-owned delegation_verify. Zmieniono wyłącznie projekt/dokumentację i TODO, bez implementacji nowych funkcji i bez poprawiania bieżących testów.

Potwierdzone uwagi:

- P1: reprezentację activeScoutScans trzeba wprowadzić razem z adapterami wszystkich konsumentów w kroku 1, również autofill i runtime drain/status. Kod runtime-control liczy obecnie singleton i tylko niewygasły token. Kolejny etap nie może dopiero naprawiać połamanej bazowej ścieżki. Nowy plan przypisuje zgodność storage/consumers do kroku 1, pełny lifecycle do 3, rozszerzenie wieloprofilowego API/wyników do 4.
- P1: brakło jednoznacznej drogi reserved/uncertain → terminal oraz związku readyForRestart z faktyczną zajętością. Dopisano deadline startu 120 s, durable attempt/launch/accept, probe liveness/review, reconciliation również przy drain/off/pause i szczególne przypadki crash/niepewnego handoff.
- P2: rzeczywisty start to sdkMode=agent i mode=agent (scout:1781,1799). Obecny prompt nazywa to PLAN, a wcześniejszy projekt zakładał Plan mode. Zmieniono opis transportu i rozdzielono go od hostowej polityki tylko do odczytu.
- P2: zwykły started=false celowo konsumuje stempel harmonogramu i budżet (scout:1955–1968); brak przyjęcia startu nie wystarcza sam do refundu. Dodano tabelę rozliczeń, bez nadpisania całego previousScans.

Kwalifikacje propozycji Groka:

- Nie zastosowano zwalniania slotu wyłącznie na podstawie braku chatu lub upływu deadline. Po możliwym handoff brak chatu może oznaczać niepewny start; wymagane jest potwierdzenie braku procesu/próby i review. Unknown pozostaje zajęty.
- Allowlista list/submit w Plan/Ask nie jest obecną ochroną agent mode. `denyMutatingBuiltinTool` w catalog.js dopuszcza tryb agent, a mcp-policy.js stosuje blokadę dla read-only mode/assignment. Nie twierdzimy, że Scout w agent już ma tę ochronę. Nowe konfigurowalne profile wymagają hostowej polityki read-only niezależnej od transportu; harness bez takiego egzekwowania ma być zablokowany dla tej funkcji.
- Scenariusz utraty singletona po kroku 1 nie jest dowodem istniejącej awarii wdrożonego kodu: to ryzyko realizacji zbyt ogólnego planu. Specyfikacja i taski mają teraz jawny obowiązek migracji wszystkich call-sites w jednym etapie.

## Nowa rozbieżność bazowego kodu/testu

Host-owned `delegation_verify` dla `workspace-watcher-scout` zakończył się **failed**, exit 1, w izolowanym katalogu `/tmp/cretli-review-verify-data-0RCv9G`.

Jedyny zgłoszony failing case: `record/accept/reject proposals; only scoutAutoCreate creates a todo`, `tests/workspace-watcher-scout.test.js:465`, oczekiwano 1 createdTodos po osobnym accept, otrzymano 0. Pozostałe przypadki tego uruchomienia wypisały OK.

Rodzic sprawdził `recordScoutFindings`: aktualny working tree przy scoutAutoCreate=true wywołuje accept i tworzy TODO już przy zapisie nowych wyników (scout:1250–1278). Późniejszy accept jest replay/no-op, więc test oczekujący tworzenia dopiero przy akceptacji jest niezgodny z tym zachowaniem. Ten kod nie został zmieniony w recenzji; workspace miał cudze niezacommitowane zmiany. Nie ustalano autorstwa zmiany i nie deklarujemy, czy docelowo powinien zostać zmieniony kod czy test.

Projekt profili ma zachować aktualny opt-in automatycznego przechwytywania pomysłów, nadal wyłącznie TODO idea bez zatwierdzenia/uruchomienia. Dodano obowiązek uzgodnienia bieżącego kontraktu i regresji w kroku 4 oraz odbioru w 6. Historyczny PASS z audytu DeepSeek opisuje wcześniejsze uruchomienie, nie zastępuje aktualnego failed.

## Artefakty i status

Decyzje po weryfikacji zapisano w `docs/configurable-scouts.md` i podzadaniach root TODO. Statusy pozostają idea, plan pozostaje niezatwierdzony. Grok nie recenzował tych ostatnich poprawek ponownie; brak deklaracji końcowego PASS. Funkcja nadal jest projektem do implementacji. Nie uruchamiano pełnego zestawu testów repo.

## Oryginalny raport Groka

TASK: review
VERDICT: FAIL

Recenzja tylko do odczytu poprawionego planu konfigurowalnych Scoutów (TODO 7acf66ec, docs/configurable-scouts.md + dopiski etapów 1–6). Nic nie implementowano, nie zmieniano plików ani TODO. Testów nie uruchamiano: istniejący workspace-watcher-scout nie dowodzi przyszłego kontraktu; poprzednia weryfikacja rodzica już zapisała passed.

## Co korekty naprawdę domykają

- Wspólny budżet A/B i granica UTC: zakaz przywracania całego previousScans / lastRunAt workspace jest trafny wobec rollbackScoutScan (lib/workspace-watcher-scout.js:1165–1172), który dziś nadpisuje cały licznik. Odbiór „failed A / successful B / UTC” da się wykonać.
- Atomowy dedupe/merge: dzisiejszy dedupeScoutFindings (914–946) odrzuca already_pending, a recordScoutFindings (1193–1243) liczy poza lockiem i dokleja nowe rekordy. Plan wymaga jednego locka, idempotentnego źródła i zakazu wznawiania accepted/rejected.
- Retencja pending: normalizeWorkspaceScoutFindings (336) i zapis (1243) tną slice(-200). Zakaz usuwania pending, capacity_exceeded i osobna historia decyzji są konkretne.
- Legacy kategorie i harnessy: pusty scoutCategories staje się pełnym zbiorem (persist 465–469); scoutAllowedHarnesses puste spada do allowedHarnesses (scout 1727–1730). Plan materializuje legacy i nie zamienia tego na przecięcie. Jawny executor przed policy.orchestrator, auto nowego profilu bez dziedziczenia TODO, brak cichego fallbacku dla nowego jawnego wyboru — zgodne z resolveWorkspaceWatcherOrchestrator (orchestrator.js:149–165, pierwsze favorite tylko przy samym harnessie).
- manual / enabled / archive: enabled profilu = automatyka; ręczny start przy enabled=false; archiwum blokuje start; globalny scoutEnabled, pause, stop i quiet hours zostają bramkami wszystkich startów. Zgodne z decideScoutRun (996–1002).
- Brak mixed writers, backup, brak downgrade przez pojedynczy mirror, wirtualny profil bez zapisu na GET, jeden profil ogólny zamiast sześciu skanów, produkcyjna wieloprofilowość dopiero po kroku 4, UI 5.1–5.3 sekwencyjnie. To jest wykonawczy kontrakt MVP.

## Blocker

### P1 — kolekcja skanów wchodzi w kroku 1, a życie slotu i writerzy dopiero później; expiry traci zwolnienie bez następcy

Sprzeczne fragmenty:
- Audyt, „Model skanów (kroki 1 i 3)”: store v2 i activeScoutScans oraz przepiecie reserve/submit/autofill/clear/expire/boot/parent IDs.
- Etap 1: schema v2 już teraz, a „do kroku 4 zachować działający legacy”. Główne miejsca etapu 1 to persist i control, nie runner.
- Etap 3: „MCP autofill przepiać w kroku 4”.
- Ten sam akapit audytu: wygaśnięcie tokenu nie dowodzi końca procesu; niepewny start trzyma slot aż do reconciliation. Brak predykatu zejścia ze stanu uncertain/reserved.

Dowód kodu:
- Jedyny trwały skan to activeScoutScan, zapisywany wyłącznie przez normalizer (persist 1241). Writerzy: reserve 1147, setActiveScoutScan 1498, clear bezwarunkowy po submit 1466, clear po scanId 1528, expire 1548–1556.
- Autofill czyta wyłącznie singleton (mcp-inprocess-client.js:648–656).
- Parent IDs: jeden chatId (workspace-watcher.js:297–299).
- Boot czyści wygasły skan przed archiwizacją (workspace-watcher.js:1716–1718).
- Drain/readyForRestart liczy tylko niewygasły activeScoutScan (workspace-watcher-runtime-control.js:73–74). Tego pliku nie ma na liście call-site.
- Rezerwacja powstaje z pustym chatId (1148–1149), więc sam probe chatu jej nie widzi. Cykl Watchera ma deadline startu (WORKSPACE_WATCHER_CYCLE_START_DEADLINE_MS); Scout takiego progu w planie nie dostaje.

Scenariusz: po etapie 1 normalizer v2 przestaje wynosić activeScoutScan, a runner nadal je zapisuje. Pierwszy mutate kasuje żywy token i legacy submit/autofill padają, wbrew „legacy po każdym etapie”. Jeśli expiry przestaje zwalniać slot, a reconciliation nie ma reguły (brak chatu, idle, unknown, rezerwacja bez chatId), scoutMaxParallel zostaje zajęty po crashu albo restart uzna proces za martwy i puści drugi skan. To nowe ryzyko korekty, nie brak przyszłej funkcji.

Minimalna korekta (etapy 1 i 3, jeden dopisek):
- W tym samym kroku co zmiana pola przenieść wszystkie odczyty i zapisy singletona: runner, autofill, parent IDs, boot, archive i getWorkspaceWatcherRuntimeStatus. Do końca etapu 4 produkcja i tak ma najwyżej jeden skan profilu ogólnego; autofill wielu chatów może dojrzewać w etapie 4, ale nie może zostać na usuniętym polu.
- Reconciliation: probe liveness chatu/runu i slot review. Brak chatu albo potwierdzone idle bez review → interrupted, zdjęcie zajętości, bez drugiego refundu po przyjęciu startu. unknown/busy oraz review po clear tokenu zostają w liczniku. Rezerwacja z pustym chatId po krótkim deadline startu (wzorzec cyklu, nie TTL submitu) → failed i jeden refund, jeśli start nie został przyjęty. readyForRestart liczy te stany, nie sam expiresAt.

## P2 — nie blokują samodzielnie, ale są sprzecznościami planu

### P2 — „Plan mode” nie jest rzeczywistym startem Scouta
Spec (sekcja 5, akapity o prompcie i globach) każe zachować Plan mode. Runner startuje sdkMode agent (workspace-watcher-scout.js:15–16 i 1781), bo plan mode urywa harnessy spoza SDK. Wyjątek MCP list/submit dla plan/ask (lib/mcp/builtin/catalog.js:29–31, 65–67) to allowlista narzędzi, nie tryb startu. docs/workspace-watcher.md:293 i 309 są nieaktualne. Ryzyko: etap 2/6 „naprawi” start na plan i zepsuje obecnego Scouta. Korekta: własne instrukcje nie poszerzają narzędzi; zachować start agent oraz obecną allowlistę list/submit; nie przełączać Scouta na Plan mode. Etap 2 i 6.

### P2 — refund da się odczytać szerzej niż obecna semantyka
Audyt: „Refund tylko przed przyjęciem startu”. Sekcja 4: nieudany start zwalnia rezerwację „według obecnej semantyki”. Dziś started===false (brak modelu) zjada dzienny stempel celowo (scout.js:1941–1953), żeby heartbeat nie ponawiał co tick; refund jest przy throw przed accept i przy global_starts_disabled. Korekta w etapie 3: brak executora nadal konsumuje licznik profilu i workspace; refund raz, dekrementacją dnia rezerwacji, tylko gdy start nie został przyjęty (wyjątek global disable zostaje).

## Świadomie nie podnoszone

Singleton, odrzucanie duplikatu i brak historii per profil to stan kodu, a plan ma na nie konkretną zmianę. Uczciwa kolejność bez nazwy algorytmu i brak limitu liczby decyzji są do doprecyzowania przy implementacji, nie są blockerem: odbiór głodzenia i zakaz reaktywacji rejected już są.

## Testy

Nie uruchamiano node scripts/review-verify.js ani testów zapisujących dane aplikacji.

## Odchylenia

Brak edycji i brak nowej delegacji. Werdykt dotyczy planu, nie gotowej funkcji.

TASK: review
VERDICT: FAIL

