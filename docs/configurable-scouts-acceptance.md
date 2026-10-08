# Odbiór MVP — Konfigurowalne Scouty (krok 6)

Raport pokrycia kryteriów specyfikacji [`configurable-scouts.md`](./configurable-scouts.md)
stanem na drzewo robocze. Leaf audytowo-dokumentacyjny: weryfikuje kompletny MVP,
domyka wykryte luki testowe, aktualizuje dokumentację i opisuje procedurę wdrożenia.
Nie wdraża nowych funkcji.

- Todo: `78abc5ba-7c60-4d2e-bee6-a93b4b37d4e7` (parent `7acf66ec-d231-4c94-9492-aef8ac00f600`, gałąź `next/2026-09-28`)
- Delegacja: `53fc3b1e-786a-46e8-9d36-2b575c0e2001`
- Material revision cyklu: `79b8329dc13c` + `5c8cbde5a994` (drzewo brudne, wiele leafów bez commitów)
- Specyfikacja: [`configurable-scouts.md`](./configurable-scouts.md); raport planu:
  [`configurable-scouts-review.md`](./configurable-scouts-review.md); raport Grok:
  [`configurable-scouts-grok-review.md`](./configurable-scouts-grok-review.md)
- Dokumentacja operatorska (zaktualizowana w tym leafie): [`workspace-watcher.md`](./workspace-watcher.md)

Legenda statusów:
- ✅ **spełnione** — udokumentowane istniejącym testem uruchomionym w tym leafie (rc=0)
- 🔧 **luka-uzupełniona** — kryterium nie miało dowodu; w tym leafie dopisano test i uruchomiono go na zielono
- ⚠️ **luka-pozostająca** — niezgodność zgłoszona, poza zakresem naprawy tego leafa (zmiany w `lib/**`)
- 🖐 **dowód częściowo ręczny / human-gated** — testy integracyjne na wstrzykiwanych deps/mock adapter; pełny runtime na żywym serwerze wymaga ręcznej weryfikacji

## 1. Pokrycie kryteriów zadania (A–I)

### A. Scenariusze

- **A1** migracja istniejącego Scouta → dwa różne profile → wyniki → akceptacja TODO — ✅ (skomponowane ze scenariuszy jednostkowych; nie ma jednego testu „od-do”, ale każdy etap ma własny dowód, a współistnienie dwóch profili potwierdzają testy współbieżności)
  - migracja: `workspace-scout-profiles.test.js:237` „legacy policy.scout* migrates to exactly one general profile”, `:292` „legacy empty scoutCategories materialize as all categories”, `:422` „migration keeps legacy scout state intact through a round-trip”
  - utworzenie dwóch profili: `workspace-scout-profiles-api.test.js:147` „create -> list -> get a profile without auto ready/approval”, `:273` „duplicate creates a distinct id without touching the source”, `:970` „editing one profile leaves another profile and the scan reservations untouched”; różne prompty/konteksty dwóch profili: `workspace-scout-templates-scope.test.js:265` „two profiles produce different prompts and contexts”
  - wyniki i akceptacja → TODO `idea`: `workspace-watcher-scout.test.js:440` „record/accept/reject proposals; only scoutAutoCreate creates a todo”
- **A2** wspólne i indywidualne budżety; uczciwy scheduler; CAS; snapshot po edycji; archiwizacja podczas skanu; failed start; restart — ✅
  - budżety: `workspace-scout-schedule.test.js:148` „per-profile schedule state drives nextRunAt and the UTC counter”, `:196` wspólny budżet workspace (`scoutMaxPerDay`), `:721` „a Scout scan never touches the todo cycle budget or active cycles”
  - uczciwy scheduler: `workspace-scout-schedule.test.js:229` „a frequently run profile never starves the others”, `:806` „the heartbeat pass picks the oldest profile when only one slot is free”
  - CAS: `workspace-scout-profiles.test.js:361` „upsertWorkspaceScoutProfile creates, bumps revision and enforces CAS”; `workspace-scout-profiles-api.test.js:186` „PATCH with a stale revision returns 409 and changes nothing”, `:236` „PATCH virtual scout-general uses CAS before materializing”, `:913` „restore-diff and restore apply the template definition under CAS”
  - snapshot po edycji: `workspace-scout-schedule.test.js:689` „a running scan keeps its reserved profile snapshot after an edit”; snapshot profilu przy rezerwacji: `workspace-scout-scans.test.js:177` „legacy activeScoutScan migrates to exactly one collection record with a general snapshot”
  - archiwizacja podczas skanu: `workspace-scout-scans.test.js:246` „two parallel scans coexist; expiry of one never removes the other”; `workspace-watcher-archive-sweep.test.js:198` „never sweeps a chat that still orchestrates a live cycle”; `workspace-watcher-scout.test.js:1124` „archive sweep leaves a live-run scout submit alone (submit never archives)”, `:1344` „archive sweep keeps a scout child that holds a slot and refuses its parent”
  - failed start: `workspace-scout-schedule.test.js:313` „failed start A refunds its own profile counter and never touches a successful B”; `workspace-scout-scans.test.js:883` „a scan that never started settles its history as failed (M4)”
  - restart: `workspace-scout-schedule.test.js:828` „boot reconcile refunds a crashed reservation and keeps a launched one”, `:988` „finding 4: v1 legacy migration with chatId sets launchIssued, not refunded on boot”; żywe credentials po restarcie: `workspace-watcher-scout.test.js:975` „an accepted async scan keeps its active credentials and consumes the stamp”, `:1316` „boot reconcile clears expired activeScoutScan before archive sweep”

### B. Kontrakty

- **B1** zakres/źródła; uprawnienia kontraktu read-only; submit token; deduplikacja MIĘDZY profilami; pamięć obszaru dla różnych celów — ✅
  - zakres/źródła: `workspace-scout-templates-scope.test.js:203` „area scope include/exclude decides matchedFiles and markers”, `:237` „source toggles gate git/tests/logs while dedup context is always included”, `:221`/`:402` „empty scope match never falls back to a full-repo scan”; pełny zakres Git: cały `workspace-scout-git-scope.test.js` (15 testów)
  - read-only (niezależnie od transportu agent): `workspace-scout-templates-scope.test.js:323` „native mutation and delegation are denied; reads are allowed”, `:352` „production resolvePlanModeToolDecision matches scout read-only policy in agent mode”, `:387` „OpenCode scoutReadOnly rejects task and agent permissions”, `:415` „OpenRouter executor blocks writes when scoutReadOnly is set on context”, `:426` „SDK create options deny edit and shell for scoutReadOnly”, `:433` „scout SDK event decision blocks writes in technical agent mode”, `:457` „builtin MCP tools deny mutation and allow read/submit for a Scout chat”, `:489` „a non-scout chat is unaffected by the scout gate”; ścieżka startu blokuje harness bez read-only: `workspace-scout-profiles-api.test.js:1129`/`:1158`
  - submit token: `workspace-watcher-scout.test.js:795` „active Scout scan expires and cannot submit afterward”, `:1071` „Scout prompt recommended submit example carries scan_id + submit_token”, `:1082` „submit succeeds with the recommended credentials from the active scout chat”; `workspace-scout-scans.test.js:760` „submit cannot smuggle attribution”, `:686` „forcePending normalizes away caller sources/source/scanId/sourceChatId”, `:1198` „submit rejects a foreign chat/token and scan B attribution never leaks to A”
  - deduplikacja między profilami: `workspace-scout-scans.test.js:971` „duplicate submissions merge into one proposal with two sources, replay is idempotent”, `:1023` „cross-process race: two children submit the same problem into one merged proposal”, `:1146` „re-proposing a resolved finding merges attribution without reopening it”, `:1340` „a same-scan merge that fills an empty source field is persisted”; dedup przeciw TODO/decyzjom/pamięci: `workspace-watcher-scout.test.js:270`/`:291`
  - pamięć obszaru dla różnych celów: `workspace-watcher-scout.test.js:308` „isExploredMemoryEntry ignores generic covered/scanned value-only notes” (oznacza obszar przy celu/zakresie, nie gołe „scanned”), `:1463` regex rozróżnia „already explored/scanned/area explored/fully audited”; kontekst dedup (TODO + poprzednie findings + Workspace Memory) zawsze dołączany: `templates-scope.test.js:237`

### C. Testy regresji

- **C1** uruchomić istniejące regresje i uzupełnić TYLKO wykryte luki — 🔧 (wszystkie 29 suite'ów zielone; jedna luka domknięta — patrz §3)
- **C2** zgodność starych REST/MCP i klientów zdalnych — ✅
  - `workspace-scout-profiles-api.test.js:515` „legacy GET/POST /api/workspace-watcher/scout keep working”, `:540` „profile-scoped scout run route is registered”, `:549` „legacy POST /scout action=run forwards scoutId (REST + MCP profiles run + in-process)”, `:445` „GET /scout filters findings by scoutId without changing the legacy shape”, `:637` „list/get carry an additive per-profile state without changing the profile shape”, `:590` „MCP scout_profiles validates before dispatch and scout_id is forwarded”
  - brak drugiego writeera / starszy widok singletona: `workspace-scout-scans.test.js:227` „an explicit activeScoutScans key (even []) is never migrated again”, `:905` „getActiveScoutScans ignores the legacy singleton once the collection key exists (N1)”, `:177` migracja `activeScoutScan`→kolekcja z zachowaniem tokenu, `:594` „legacy source migrates into sources[0] without inventing fields”
  - klienci zdalni: `lib/remote-api-client.js` `workspaceWatcherScout` (legacy, ścieżki `GET/POST /api/workspace-watcher/scout` z opcjonalnym `scoutId` i `scoutSubmitToken`, linia ~700) + nowe `workspaceWatcherScoutProfiles` (~743); regresja legacy: `tests/remote-api-client.test.js:213` `workspaceWatcherScout({ ... scoutSubmitToken, findings })` → `action:'submit'`

### D. Kryteria z sekcji audytu (szczególne)

- **D1** dwa równoczesne submit — ✅ `workspace-scout-scans.test.js:246` „two parallel scans coexist; expiry of one never removes the other”, `:277` „submit A is authorized while a parallel scan B is present”, `:1023` cross-process race dwóch submitów → jedna scalona propozycja
- **D2** failed A / success B / UTC — ✅ `workspace-scout-schedule.test.js:313` failed start A refunds own counter, B zachowuje (`a.count 0`, `b.count 1`, `row.scoutScans.count 1`); `:343` „a failed start across a UTC boundary never decrements the new day counter”; `workspace-scout-scans.test.js:855` „rollback across a UTC day boundary never decrements the new day counter (M2b)”
- **D3** expiry A przy działającym B — ✅ `workspace-scout-schedule.test.js:579` „expiry of A never removes a parallel B and a launched scan skips legacy expiry”, `:942` „finding 3: submit after expiresAt keeps slot of a launched scan”; `workspace-scout-scans.test.js:246`
- **D4** MCP autofill własnego chatu — ✅ `workspace-watcher-scout.test.js:1082` „submit succeeds with the recommended credentials from the active scout chat”; nie ujawnia tokenu innego chatu: `workspace-scout-scans.test.js:1198` „submit rejects a foreign chat/token and scan B attribution never leaks to A”; `workspace-scout-profiles-api.test.js:590` „scout_id is forwarded”
- **D5** review po clear tokenu — ✅ `workspace-scout-schedule.test.js:542` „expired-but-busy stays occupied; review delegation keeps the slot”, `:506` „no response after acceptance stays occupied; confirmed idle with no review releases”; clear tokenu nie kasuje następcy ani lineage: `workspace-scout-scans.test.js:344` „clearActiveScoutScanIfScanId does not clear a successor scan”, `workspace-watcher-scout.test.js:1006` „clearActiveScoutScanIfScanId never clears a successor scan”
- **D6** 201. pending — ✅ `workspace-scout-scans.test.js:1082` „capacity_exceeded rejects a 201st unique finding without dropping the oldest”, `:1115` „normalization keeps overflow pending and migrates terminal findings to the decision history”
- **D7** czyszczenie historii — ✅ `workspace-scout-scans.test.js:527` „scan history caps terminal entries per profile and per workspace, never non-terminal”, `:1440` „auto-created Scout todo keeps its minimal source after scan history is cleared”, `:1368` „the default list keeps decisions visible when the pending mailbox is full”, `:1394` „a decision tombstone keeps a rejected idea rejected past the 500-entry cap”
- **D8** GET bez zapisu — ✅ `workspace-scout-profiles.test.js:324` „empty workspace reads the virtual general profile and writes nothing”, `:349` „a non-empty stored list is returned without the virtual general profile”; `workspace-scout-profiles-api.test.js:788` „GET /scout/templates returns the versioned catalog as deep copies” (deep copy = mutacja wyniku nie nadpisuje katalogu)
- **D9** precedencja executora — ✅ `workspace-scout-schedule.test.js:371` „an explicit profile executor overrides the legacy orchestrator and narrows harnesses”, `:402` „an empty profile/global harness intersection blocks the start with a clear reason” (`executor_not_allowed`); jawny executor bez harnessu odrzucany: `workspace-scout-profiles-api.test.js:1186`; auto nie dziedziczy orkiestratora cyklu: `workspace-scout-schedule.test.js:396` (w `:371`) `assert.auto never inherits a cycle orchestrator`; podgląd ignoruje jawny executor przy auto: `workspace-scout-profiles-api.test.js:1094`
- **D10** działający legacy po każdym etapie + blokada niekompletnej wieloprofilowości przed ukończeniem kroku 4 — ✅ / 🖐
  - legacy działa po przejściu schematu: `workspace-scout-profiles-api.test.js:515`, `workspace-scout-scans.test.js:177` + `:905` (singleton ustępuje kolekcji), `workspace-scout-profiles.test.js:422` (round-trip zachowuje stan)
  - blokada wieloprofilowości przed krokiem 4 oraz „test działającego legacy po każdym etapie” to gwarancja PROCESOWA z audytu (sekcja DeepSeek „Model skanów i działające etapy pośrednie”): produktowy runner do ukończenia kroku 4 korzystał wyłącznie z migrowanego profilu ogólnego. Po ukończonym kroku 4 bramka jest otwarta — potwierdzone zielonymi testami profili w krokach 4–5. Brak jednego testu „etyap-po-etapie” (historia commitów na brudnym drzewie tego nie odtwarza) → dowód częściowo ręczny / historyczny.

### E. Korekta po Grok 4.7

- **E1** odbiór legacy po kroku 1 obejmuje prawdziwy runtime/MCP, runtime drain i zachowanie żywych credentials, nie tylko normalizator — ✅ (jednostkowo) / 🖐 (pełny runtime na żywym serwerze)
  - żywe credentials: `workspace-watcher-scout.test.js:975` „an accepted async scan keeps its active credentials and consumes the stamp”, `:1082` submit z rekomendowanymi credentials aktywnego chatu, `:1025`/`:1006` clear kasuje wyłącznie wskazany skan (chat identyfikuje własne credentials)
  - runtime drain: `workspace-scout-schedule.test.js:606` „drain: reconciliation runs while off and unknown never yields readyForRestart”, `:662` „readyForRestart is blocked by an unreadable store, never only by expiresAt”
  - prawdziwy runtime/MCP legacy → human-gated: testy używają DI (`deps.runScout`, `deps.execGit`) i mock adaptera;端到-end na żywym serwerze (realny harness + realny restart procesu) wymaga ręcznego przebiegu rollout opisanego w `workspace-watcher.md`
- **E2** testy deadline/reconciliation — ✅
  - orphan przed launch: `workspace-scout-schedule.test.js:425` „crash before handoff past the start deadline refunds exactly once”, `:869` „finding 1: deadline does NOT free a reservation owned by the current instance”, `:891` „reconcileScoutScans TTL branch respects ownerDead”, `:1035` „finding 5: refund orphan restores lastRunAt instead of zeroing it”, `:1188`/`:1233`/`:1260` e2e orphan refund
  - throw z potwierdzonym nieprzyjęciem: `workspace-scout-schedule.test.js:922` „finding 2: throw after launchIssued → uncertain, slot occupied”; potwierdzony brak przyjęcia → refund: `:1287` „finding 4 negative: v1 legacy scan without chatId is refunded after deadline”, `:425`
  - **started=false consuming budget** → 🔧 **luka-uzupełniona** w tym leafie (patrz §3): dodano `workspace-scout-schedule.test.js` „a normal started=false consumes the profile and workspace daily budget (refund table)”
  - utrata odpowiedzi po handoff: `workspace-scout-schedule.test.js:475` „delayed/uncertain handoff: launched, no chat, deadline passed -> uncertain, no refund”, `:506` „no response after acceptance stays occupied”
  - expired-but-busy/unknown/review: `workspace-scout-schedule.test.js:542` „expired-but-busy stays occupied; review delegation keeps the slot”, `:942` submit po `expiresAt` utrzymuje slot uruchomionego skanu
  - drain przy off/pause: `workspace-scout-schedule.test.js:606` (reconciliation działa przy wyłączonych startach), `:828` boot reconcile
  - read-only polityka w agent mode: `workspace-scout-templates-scope.test.js:352` (produkcyjny `resolvePlanModeToolDecision` stosuje politykę read-only Scouta w agent mode), `:433` „scout SDK event decision blocks writes in technical agent mode”, `:364`/`:387`/`:415`/`:426`
- **E3** specyfikacja ma tabelę refundów; zweryfikować istnienie i zgodność z kodem — ✅ (tabela istnieje w `configurable-scouts.md`, sekcja „Doprecyzowania po recenzji Grok 4.7”, wiersze 1:1 zgodne z kodem; kolumna „normalne started=false → Zużyty / slot zwolniony” udokumentowana uzupełnionym testem; aktualizacja statusu w `configurable-scouts.md` → „Status odbioru (krok 6)”)
  - wiersz „Start przyjęty, późniejszy błąd lub interrupted → Zużyty; do potwierdzenia idle i końca review” ↔ `workspace-scout-scans.test.js:508` „expiry settles the matching history entry as interrupted” + `workspace-scout-schedule.test.js:542`
  - wiersz „Timeout/throw po możliwym handoff, busy/unknown → bez refundu; zajęty” ↔ `workspace-scout-schedule.test.js:475`, `:751` „markScoutScanLaunchIssued and markScoutScanUncertain keep the record and slot”

### F. Dokumentacja

- **F1** `docs/workspace-watcher.md` — ✅ uzupełnione luki (rollout/migracja/backup były nieobecne): dodano podsekcje „Scout profiles, migration and history”, „Backward compatibility for REST / MCP / remote clients”, „Rollout, backup and restore (schema v1 → v2)”, „Scout troubleshooting”, rozszerzono „Control surfaces” (REST profile endpoints + MCP `scout_profiles`, skorygowano opis read-only `scout_findings`) i lista testów Scouta
- **F2** specyfikacja profili — ✅ `configurable-scouts.md`: dodano sekcję „Status odbioru (krok 6)” domykającą zapis o „backlogu”, potwierdzającą wdrożenie kroków 1–5 i schemat v2, wskazującą zgodność tabeli refundów z kodem oraz jedyną pozostałą niezgodność (martwy `buildScoutPrompt`)
- **F3** `CHANGELOG.md` — ✅ dopisano w `[Unreleased] → Added` pozycję „Configurable Workspace Scout profiles (MVP — steps 1–5)” bez duplikacji istniejących wpisów o bazowym Scout i `scout_profiles`

### G. Procedura wdrożenia i odtworzenia danych

- **G1/G2** — ✅ zapisana w `workspace-watcher.md` → „Rollout, backup and restore (schema v1 → v2)”: backup → zatrzymanie writerów/nowych startów → migracja jednym writerem → weryfikacja legacy → dopiero potem tworzenie/łączenie kolejnych profili; powrót do v1 wyłącznie przez restore kopii; bez obietnicy mixed-version i bez bezpiecznego downgrade do starego store. Granice wsparcia: zgodność odczytu klientów TAK, jednoczesny zapis starego+nowego serwera NIE.

### H. Zakres MVP

- **H1** import/eksport profili, biblioteka między workspace, wyzwalacze zdarzeniowe NIE są zaimplementowane — ✅ (potwierdzone brakiem automatycznych ścieżek w kodzie: brak ścieżek import/export/library/event-trigger w `lib/workspace-watcher-scout.js`, `lib/persist/workspace-watchers-persist.js`, `lib/routes/workspace-watcher-routes.js`, `lib/mcp/builtin/watcher-tools.js` — `SCOUT_PROFILE_ACTIONS` to wyłącznie `list, get, create, update, duplicate, archive, preview, history, run, templates, from_template, restore_preview, restore`). Granicę opisano w `configurable-scouts.md` → „Zakres MVP i później” (Później) oraz w `workspace-watcher.md`.

### I. Odbiór całości

- **I1** wynikowy dokument pokrycia — ✅ niniejszy plik
- **I2** nowy profil domyślnie ręczny; `scoutAutoCreate` materializuje tylko TODO `idea` z niezatwierdzonym planem (bez auto-execution) — ✅
  - domyślnie wyłączony profil ogólny: `workspace-scout-profiles.test.js:156` „defaultWorkspaceScoutProfile is the deterministic disabled general profile”, `:324` wirtualny wyłączony profil bez zapisu; `manual+disabled` przy create/from-template: `workspace-scout-profiles-api.test.js:808` „POST /profiles/from-template validates, saves disabled+manual and keeps the template link”, `workspace-scout-templates-scope.test.js:147` „materializeProfileFromTemplate returns an independent, disabled profile”
  - autoCreate → tylko `idea` z niezatwierdzonym planem: `workspace-watcher-scout.test.js:440` asserts `created.status === 'idea'`, `created.plan.approvedAt === undefined`, dokładnie jedno TODO, idempotentny accept (changed 0, bez duplikatu), replay nie nadpisuje planu (`planWrites === 0`), terminalne findings nie są ponownie rozwiązywane
  - create/get bez auto ready/approval: `workspace-scout-profiles-api.test.js:147` „create -> list -> get a profile without auto ready/approval”
- **I3** działające scenariusze dwóch profili i legacy — ✅ na istniejących testach integracyjnych (nazwanych wyżej; współistnienie dwóch profili: `scans:246`/`:277`/`:1023`, legacy: `api:515`/`:549`) / 🖐 pełny runtime na żywym serwerze oznaczony jako human-gated (E1) — testy w tym repo używają mock chat-run adaptera i DI, więc nie zastępują ręcznego przebiegu na żywym processie.

## 2. Kryteria odbioru ze specyfikacji (`configurable-scouts.md` → „Kryteria odbioru”)

| Kryterium | Dowód | Status |
|---|---|---|
| Dwa własne profile o różnych celach/zakresach; niezależne uruchomienia, prompt, harmonogram, historia | `templates-scope:265` różne prompty; `schedule:299`/`:775` niezależne rezerwacje; `scans:246` historia/sloty niezależne | ✅ |
| Edycja/duplikacja szablonu nie zmienia innych profili; snapshot trwającego skanu niezmienny | `api:970` edycja nie dotyka innego profilu; `schedule:689` snapshot po edycji; `api:273` duplicate | ✅ |
| Współdzielony budżet i limit równoległości; pause/quiet hours/stop blokują też ręczne starty; żaden Scout nie zajmuje slotu TODO | `schedule:148`/`:178`/`:212`; `watcher-scout:337` `decideScoutRun` (opt-in/mode/quiet/interval/budget); `schedule:721` nie tyka budżetu cykli | ✅ |
| Brak podwójnego startu (równoległy klik/heartbeat); restart i nieudany start nie psują liczników | `schedule:299` drugi start tego samego ticka respektuje cap; `schedule:246` jeden nierozliczony skan na profil; `schedule:313`/`:343`; `schedule:828` boot reconcile | ✅ |
| Wyniki spoza zakresu i niepoprawny submit/token odrzucane; własny prompt nie rozszerza uprawnień | `git-scope` cały; `templates-scope:402`; `scans:1198` obcy chat/token; `templates-scope:323`/`:433` polityka hosta niezależna od promptu | ✅ |
| Ten sam problem z dwóch profili → jedna propozycja/TODO ze źródłami | `scans:971`/`:1023` scalanie dwóch źródeł; `scans:1146` merge bez ponownego otwarcia | ✅ |
| Akceptacja zostawia zasadę idea/niezatwierdzony plan; nie uruchamia implementacji | `watcher-scout:440` `status='idea'`, `approvedAt===undefined` | ✅ |
| Migracja ponowiona nie duplikuje profilu/skanów; zachowuje konfigurację, historię, limity i istniejących klientów | `profiles:237`/`:422`; `scans:227`/`:905`; `api:515`/`:549`/`:445` | ✅ |
| Regresje obejmują współbieżność, migrację, restart, deduplikację, zakres, uprawnienia; istniejące testy Scouta/Watchera przechodzą | §4 — 29/29 rc=0 | ✅ |

## 3. Luka testowa uzupełniona w tym leafie (C1)

**Kryterium:** wiersz tabeli refundów „Normalne `started=false` (brak modelu / odmowa utworzenia chatu) → budżet **zużyty**, slot równoległy **zwolniony**” (E2/E3).

**Stan przed:** kod jest poprawny — `lib/workspace-watcher-scout.js:3895` (gałąź `job.started === false`) dla powodów innych niż `global_starts_disabled` wywołuje `clearActiveScoutScanIfScanId(... status:'failed')`, zwalniając slot bez rollbacku licznika (komentarz w kodzie: „keeps the stamp on purpose … consumes the schedule slot so a missing model cannot make every heartbeat retry”). **Brak było jednak testu afirmującego zużycie budżetu**: istniejące testy dowodziły tylko kierunku zwrotu — `schedule:313` (`runScout` rzuca → `count 0`) i refundy orphan (`schedule:425`), a `scans:883`/`schedule:402` assertują `scanned:false` i status historii, nigdy `count===1`.

**Zmiana:** dopisano w `tests/workspace-scout-schedule.test.js` (pliku należącego do kroków 1–5) test:
`a normal started=false consumes the profile and workspace daily budget (refund table)` — assertuje `state.count===1` (profil), `row.scoutScans.count===1` (workspace), `state.lastRunAt===now` (harmonogram przesunięty → brak retry-loop), `getActiveScoutScans(row)===[]` (slot zwolniony) i `scoutScanHistory.status==='failed'`. Komentarze po angielsku (reguła projektu). Edycja addytywna, wyłącznie w `tests/**`.

**Wynik:** `node tests/workspace-scout-schedule.test.js` → **rc=0, 40 OK** (było 39). Bez FAIL.

## 4. Uruchomione testy regresji (C1) — dowody

Wszystkie 29 suite'ów: **rc=0**. Style uruchamiania mieszane (`node --test` dla suite'ów `node:test`, plain `node` dla własnego tally). Uruchomiono każdorazowo z `timeout`, osobno, na drzewie roboczym.

| Suite | Runner | Wynik |
|---|---|---|
| tests/workspace-watcher-scout.test.js | node | rc=0, 44 OK |
| tests/workspace-scout-profiles.test.js | node | rc=0, 14 OK |
| tests/workspace-scout-profiles-api.test.js | node | rc=0, 28 OK |
| tests/workspace-scout-scans.test.js | node | rc=0, 36 OK |
| tests/workspace-scout-schedule.test.js | node | rc=0, 40 OK (po uzupełnieniu; było 39) |
| tests/workspace-scout-templates-scope.test.js | node | rc=0, 19 OK |
| tests/workspace-scout-git-scope.test.js | node --test | rc=0, 15 pass |
| tests/workspace-scout-scan-usage.test.js | node --test | rc=0, 4 pass |
| tests/workspace-scout-profiles-ui.test.js | node --test | rc=0, 14 pass |
| tests/workspace-scout-editor-ui.test.js | node --test | rc=0, 12 pass |
| tests/workspace-scout-history-ui.test.js | node --test | rc=0, 7 pass |
| tests/workspace-scout-inbox-ui.test.js | node --test | rc=0, 7 pass |
| tests/workspace-watcher.test.js | node | rc=0 („passed”) |
| tests/workspace-watcher-e2e.test.js | node | rc=0 („E2E passed”) |
| tests/workspace-watcher-events.test.js | node | rc=0 („all passed”) |
| tests/workspace-watcher-live.test.js | node | rc=0 |
| tests/workspace-watcher-orchestrator.test.js | node | rc=0 („passed”) |
| tests/workspace-watcher-pinned-chat.test.js | node | rc=0 („passed”) |
| tests/workspace-watcher-routes.test.js | node | rc=0 („passed”) |
| tests/workspace-watcher-archive-sweep.test.js | node | rc=0 („passed”) |
| tests/workspace-watcher-delegation-guard.test.js | node --test | rc=0, 5 pass |
| tests/workspace-watcher-panel-ui.test.js | node --test | rc=0, 12 pass |
| tests/workspace-watcher-policy-editor-ui.test.js | node --test | rc=0, 11 pass |
| tests/workspace-watcher-settings-regressions.test.js | node --test | rc=0, 6 pass |
| tests/workspace-watcher-settings-ui.test.js | node --test | rc=0, 11 pass |
| tests/workspace-watcher-stats.test.js | node --test | rc=0, 9 pass |
| tests/workspace-watcher-toggle.test.js | node --test | rc=0, 6 pass |
| tests/workspace-watcher-badge-ui.test.js | node --test | rc=0, 11 pass |
| tests/workspace-watcher-dashboard-ui.test.js | node --test | rc=0, 17 pass |

Dodatkowo (katalog host-owned, jeśli dostępny): `node scripts/review-verify.js workspace-watcher-scout` mapuje id `workspace-watcher-scout` na `tests/workspace-watcher-scout.test.js`.

## 5. Zmienione pliki (ten leaf)

- `tests/workspace-scout-schedule.test.js` — dopisano test regresji „normal started=false consumes … budget” (domknięcie luki C1/E2/E3).
- `docs/workspace-watcher.md` — F1 + G: podsekcje profili/migracji/historii, zgodności wstecz, rollout/backup/restore, troubleshooting Scouta; rozbudowa Control surfaces (REST profile + MCP `scout_profiles`, korekta opisu read-only `scout_findings`); lista testów Scouta.
- `docs/configurable-scouts.md` — F2 + E3: sekcja „Status odbioru (krok 6)” (wdrożone kroki 1–5, schemat v2, zgodność tabeli refundów, pozostały finding).
- `CHANGELOG.md` — F3: wpis `[Unreleased] → Added` o konfigurowalnych profilach Scouta (bez duplikacji).
- `docs/configurable-scouts-acceptance.md` — I1: niniejszy raport pokrycia.

## 6. Luki / niezgodności pozostające (poza zakresem naprawy tego leafa)

1. **⚠️ Martwy helper `buildScoutPrompt` nadal twierdzi „You are running in PLAN mode”** (`lib/workspace-watcher-scout.js:1268/1289`). Wymóg §5 („opis roli nie może twierdzić, że transport jest w Plan mode”) i korekta Grok Krok 2 („usuń fałszywe stwierdzenie »running in PLAN mode«”) dotyczą **promptu używanego w produkcji** — tymczasem runner profili używa `buildScoutPromptForProfile`, który jest zgodny („Read-only contract (enforced by the host, not by this prompt)”, bez wzmianki o Plan mode). `buildScoutPrompt` nie ma **żadnego** wywołania w produkcji (`lib/**`, `server.js`, `scripts/`, `app_front/`) — jest używany wyłącznie przez `tests/workspace-watcher-scout.test.js`, a jego `assert.match(prompt, /PLAN mode/)` (`:234`) utrwala martwy tekst. Nie jest to wada użytkowa MVP (prompt routingu jest zgodny), więc **nie blokuje odbioru**, ale wymaga następnego kroku: usunięcie martwego helpera + aktualizacja `:234`. Naprawa dotyka `lib/**` → poza zakresem tego leafa (audyt/dokumentacja) i zgłaszana jako finding.
2. **🖐 Pełny runtime na żywym serwerze (E1/D10/I3) nie jest dowodzony automatycznie.** Testy używają mock chat-run adaptera i DI; rzeczywisty przebieg legacy→migracja→dwa profile na żywym processie i prawdziwym harnessu pozostaje human-gated. Zalecana ręczna weryfikacja według procedury „Rollout, backup and restore” w `workspace-watcher.md` przed publikacją.
3. **Drobna niespójność dokumentacyjna (historyczny wpis CHANGELOG).** Istniejący (sprzed profili) wpis `[Unreleased]` opisuje bazowego Scouta jako „starts one `plan`-mode chat”. Jest to wpis historyczny dla funkcji bazowej; nowy wpis o profilach opisuje poprawnie `agent` + egzekwowanie przez hosta. Pozostawiono bez przerabiania wpisu historycznego (ryzyko kolizji na współdzielonym drzewie); odnotowane tutaj.

## 7. Werdykt leafa

Czynności odbiorowe leafa (raport pokrycia zapisany, dokumentacja F1–F3 zaktualizowana, procedura G zapisana, C1 uruchomione i zielone wraz z domkniętą luką testową) zostały wykonane. Znalazłem jedną lukę testową (domkniętą, 🔧) i jedną niezgodność czystości kodu (martwy helper + jego test), która **nie** dotyczy użytkowego promptu produkcyjnego MVP i nie spełnia definicji blokującej wady produktowej — więc nie wymusza FAIL. Pozostaje ona zgłoszona jako finding do następnego kroku implementacyjnego (zmiana w `lib/**`).
