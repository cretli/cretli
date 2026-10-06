# Weryfikacja planu naprawy UI — Opus 5.5 i Grok 4.7

Data: 2026-10-06. Przedmiot: szkic Todo `33e307a2-741d-4ec1-94d4-2aa0a94616bb`,
rewizja `2026-10-06T13:49:49.769Z`: 6 etapów, 14 liści.
Recenzje niezależne, tylko do odczytu, bez uruchamiania implementacji.
Wykorzystany skill: [cretli-multi-harness](../.agents/skills/cretli-multi-harness/SKILL.md),
dwie jednorazowe recenzje modeli wskazanych przez użytkownika.

## Werdykty

| Model | Harness | Werdykt szkicu | Delegacja | Subchat |
| --- | --- | --- | --- | --- |
| Opus 5.5, effort medium | Claude Code | **FAIL** | `9411db9d-ab73-468f-9e71-c031d17fd5c4` | `c9ee2ca9-dcab-4074-b4e7-8f70805e2b4d` |
| Grok 4.7, reasoning medium | Cursor SDK | **FAIL** | `38b1ce94-7cf6-4b66-bcc3-b00f3617a35c` | `5544a480-ff6c-4763-9d52-8e7bf9577026` |

Obaj potwierdzili kierunek diagnozy i potrzebę poprawy lifecycle, geometrii,
raportów oraz rozmiaru DOM. FAIL dotyczy braków **planu**, nie nieukończonej
implementacji. Obie delegacje zakończyły się, a ich sloty zostały zwolnione.
Plan zachowano w dotychczasowej treści; przy root Todo zapisano wynik audytu
oraz wymagane poprawki. Nie ma zatwierdzenia ani nowego PASS.

## Synteza rodzica — wymagane korekty

### 1. Rozszerzyć lifecycle i porcjowanie na catch-up/live (Grok: bloker)

Plan 1.1/2.2 wymienia przede wszystkim replay 8/20. Tymczasem
`chatHistoryViewApply.js:95` oraz `:128` używają
`appendHistoryRecords(..., { instant: true })`. W `sdk-rich-view.js:5291`
instant wyłącza yield. Token widoku jest podbijany przy reset/destroy, ale nie
przy nowym replayu tej samej instancji (`chatHistoryConvergence.js:307,436`).

W 1.1, 1.3 i 2.2 wymagane są wspólna generacja/własność stanu oraz budżet dla
replay, append, prepend, fallbacku `applyAgentMessagesHistory`, finalizacji,
scrolla i opóźnionego Markdown. Reużyć istniejące tokeny/slice sessions.
Dodać scenariusz replay A → catch-up/live → replay B → destroy. Stary finally
nie może zmienić flag, coverage ani scrolla B. Opcja instant nie może omijać
budżetu dużego batcha.

Potwierdzone przez rodzica w kodzie. Pojedynczy ciężki rekord wymaga własnego
limitu/podglądu; yield między rekordami nie dzieli samego renderowania rekordu.

### 2. Usunąć zależność etapu 2 od późniejszego 3.2 (Opus: bloker)

2.2 wymaga ≤50 ms dla całego pipeline, choć ograniczenie karty 800 KB jest
zaplanowane dopiero w 3.2. Obaj recenzenci zauważyli ten problem; różnią się
jego wagą. Potwierdzono niespójność kryteriów szkicu.

Preferowana poprawka: przenieść ograniczony podgląd istniejących wielkich kart
przed odbiór etapu 2, zachowując ID zadania i korygując kolejność/numery oraz
plan root. Alternatywa: jawnie ograniczyć pośredni odbiór 2 do małych fixtures,
a pełny scenariusz 800 KB i native Commit oceniać dopiero po 3.2 i 4 w 5.2.
Nie oznaczać częściowego pomiaru jako PASS responsywności całej strony.

### 3. Zdefiniować odtwarzalny odbiór całego main thread (Opus: bloker)

W 0.1: dodać wersjonowany parser trace do repo z identycznymi definicjami dla
przed/po. Dotychczasowe parsery w `/tmp` nie są trwałym narzędziem odbioru.
Baseline można zamknąć na przekazanym trace z 15:13 i syntetycznych fixtures;
brak dodatkowego manualnego nagrania nie powinien blokować pierwszego liścia.

W 0.2/5.2: nazwać miary jako wszystkie zakończone `RunTask` na głównym wątku
w ustalonym oknie scenariusza, również native style/layout/Commit, bez
wykluczania ich za brak stosu JS. Zdefiniować zakres okna, zamkniętą listę
wyjątków, p95/max paczek, limity podglądu, mounted nodes/layout objects oraz
latency/queue inputu. Lista wyjątków nie może wyłączyć wielkiej karty lub
niepodzielnej pracy, która stanowi istotę regresji.

Wskazać metodę pozyskania trace: DevTools użytkownika na realnym czacie albo
hostowy Playwright/CDP na autoryzowanym, zasianym czacie-fixture z tym samym
produkcyjnym UI. Utrwalić kategorie timeline/v8/CPU/latency/counters, viewport,
dane i kroki. Dla końcowego odbioru brak wymaganego nagrania oznacza wynik
niepotwierdzony. Przegląd Browser wykonać zgodnie z obowiązującym skillem;
harness nie zastępuje wymaganego pomiaru całej aplikacji.

### 4. Doprecyzować kontrakty coverage, hydratacji i eviction

Rozstrzygnąć replace/merge local→HTTP w 0.2. Po ukończeniu właściwej generacji
koordynować `completeSdkHistoryHydration`, `armOlderSdkHistory` i
`syncRichViewPlainBuffer`; stary replay nie może opróżnić kolejki live nowego.
Flagi `suppressHistoryPersist/suppressHooksPlain/mdRenderImmediate` muszą mieć
zakres paczki/właściciela, nie wpływać na eventy live podczas yield.

**Doprecyzowanie sugestii Groka:** magazynowy ACK i viewAppliedSeq są osobnymi
stanami. `ingestChatHistoryDeltaResponse` w `sdk-chat-history-store.js:1207`
acknowledge'uje ingest niezależnie od DOM; `resetViewAppliedState` pozostawia
store ACK. Nie przyjmujemy interpretacji „nie ACK-ować całej strony serwera
bo poza DOM”. Należy zachować kontrakt ingest/persistence i osobno rejestrować
faktycznie zastosowane rekordy w modelu widoku. Zdefiniować origin/coverage
okna i tożsamość rekordów niezależnie od fizycznie zamontowanych elementów,
żeby eviction nie powodowało ponownego catch-upu/duplikatów. Status pobranego
rekordu poza oknem musi różnić się od niezastosowanej luki.

### 5. Uzupełnić zakres akumulatora i ścieżek raportów

Poza capture w `harness-plan-sync.js` i `cursor-agent-sdk-ws.js` uwzględnić
`sdk-plan-text.js:81` oraz `todo-plan-sync.js:68,100`.
Rodzic potwierdził: `readCurrentRunAssistantText` używa
`pickRicherPlanMarkdown`, które wybiera **dłuższy** tekst
(`chat-plan-markdown.js:17`). Rozdęty akumulator może więc wygrywać z poprawną
historią. Sporządzić tabelę snapshot/delta/item/boundary dla harnessów;
samo zastąpienie konkatenacji deduplikacją tekstu zgubi legalne powtórzenia.

Podgląd i kopiowanie pełnego raportu powinny korzystać z danych źródłowych,
nie z uciętego DOM. Sprawdzić delegację i oba mailboxy tego samego raportu.
Ewentualny endpoint/plik musi zachować dotychczasową autoryzację dostępu do
czatu. Zmiana generatora nie naprawia automatycznie zapisanych starych danych.

### 6. Wskazać testy i jawne ograniczenia

Rejestrować nowe testy w review-verify w liściu, który je dodaje.
Logikę schedulera/generacji testować w Node; interakcje DOM w istniejącym
harnessie Playwright uruchamianym przez hosta. Nie zakładać, że każdy reviewer
ma shell/npx. Zachować testy delta/snapshot, turn-window, generacji, scrolla,
IDB/offline i poprzedniego pollingu.

Po ograniczeniu klientowego DOM serwer nadal może zwracać poszerzoną turę
(tail=80 → setki rekordów). Koszt transferu/parse/IDB mierzyć jako ograniczenie;
nie zmieniać kontraktu pagera bez osobnej decyzji i regresji.

## Dowody i ograniczenia audytu

- Opus sam przeliczył podstawowe metryki trace przez jq i przeczytał kod.
  Nie odtworzył profilu CPU ani prywatnej historii.
- Grok przeprowadził audyt kodu/testowych kontraktów. Nie miał shell i nie
  agregował trace; liczby z diagnozy nie są jego niezależnym pomiarem.
- Rodzic dodatkowo potwierdził przez parser: 114 long tasks, 25 065,204 ms
  łącznie, max 3361,514 ms. W pamięci odtworzył błąd
  `Komentarz. RRaRapRaport` oraz zachowanie legalnej delty `Hello + world`.
  Przeczytał native/catch-up/ACK ścieżki oraz wszystkie cztery miejsca użycia
  akumulatora. Nie uruchamiano pełnej suite: oceniany jest plan, bez zmian
  implementacji.
- Opus pisał, że agent nie zbierze realnego trace sam. Przyjęta jest potrzeba
  konkretnej metody i fallbacku, nie ogólna teza o braku tej możliwości:
  należy sprawdzić dostępne narzędzia/autoryzację i użyć hostowego fixture
  tam, gdzie można.
- Pełne raporty poniżej są zachowane w oryginalnej postaci. Uwagi rodzica
  powyżej nie zmieniają ich historycznych werdyktów.

## Pełny raport Opusa 5.5

# Audyt planu 33e307a2 (rev. 2026-10-06T13:49:49.769Z)

Plan jest merytorycznie trafny i dobrze oparty na dowodach, ale ma dwa blokery po stronie sekwencji i odbioru. Oba są tanimi poprawkami tekstu planu, nie zmianą kierunku.

## Co potwierdziłem samodzielnie

- **Trace (własne zapytanie jq, PID 44408 / TID 66256):** 114 zadań >50 ms, suma 25 065 ms, max 3361,5 ms; Commit 322 / 7346,9 ms; UpdateLayoutTree 2214 / 10 658 ms; Layout 793 / 3117,6 ms, max totalObjects 276 323; RunMicrotasks 504,6 i 627,4 ms. Zgodne z dokumentem diagnozy.
- **Lifecycle replayu:** `sdk-rich-view.js:5257-5288` renderuje 20 rekordów synchronicznie i puszcza resztę przez `void replayHistoryRecordsChunkedImpl`; pętla `:4528-4552` nie ma generacji, a jej `finally` bezwarunkowo zeruje flagi i woła `scrollToBottom({force:true})`; `destroy()` `:4724-4734` jej nie zatrzymuje.
- **Coverage przed końcem rysowania:** `chat.js:4201-4204` i `:4232-4235` wołają `replaceViewAppliedRecords` i `syncRichViewPlainBuffer` zaraz po starcie replayu.
- **Wymuszony layout:** `captureInsertScroll` `:1536-1543` (`getBoundingClientRect` na rekord) wołane z `runViewApplyWithOrder` `:3606-3610`.
- **Akumulator:** `sdk-plan-text.js:13-21` porównuje snapshot z całym tekstem runu; z lektury kodu wynik `Komentarz. RRaRapRaport` jest poprawny. Wywołania `harness-plan-sync.js:64`, `cursor-agent-sdk-ws.js:1934`, publikacja `delegation-run-bridge.js:64`.
- **Okno historii:** `selectTurnAlignedHistoryWindow` (`lib/sdk/sdk-history-turn-window.js:63-76`) nie ma górnego limitu.
- Treści sprawdzonych liści (1.2, 2.2) są zgodne z planem. Dowody i hipotezy są w diagnozie rozdzielone uczciwie (m.in. brak przypisania kart do seq, brak pomiaru liczby równoległych pętli).

## Blokujące

**B1 (wysoka) — etap 2 nie da się zamknąć przed 3.2.** Etap 2 wymaga pomiaru natywnego style/layout/Commit, a 2.2 wymaga zadań pipeline ≤50 ms. Dopóki karty 800 KB renderują się w całości (`renderDelegationCard`/`renderMailboxCard`, przyrosty 48–99 tys. nodes), żaden pomiar na reprezentatywnych danych tego nie spełni: Commit 1,3–3,1 s wynika z rozmiaru drzewa, nie z geometrii. Zdanie w 2.2 „800 KB rekord ma ograniczony podgląd do etapu 3” jest niejednoznaczne.
*Poprawka:* przenieść 3.2 (limit podglądu) przed etap 2 — jest niezależne od lifecycle i daje największy zysk — albo jawnie zapisać, że fixtures 2.1/2.2 nie zawierają wielkiej karty, a kryterium Commit obowiązuje dopiero w 5.2.

**B2 (wysoka) — odbiór Chrome nie wyklucza pozornego PASS.**
- Kryterium „zadania *naprawionego pipeline* ≤50 ms” pozwala wyłączyć natywny Commit/style, którego nie da się przypisać stosowi JS. Diagnoza sama stwierdza, że task 3,36 s to głównie Commit. *Poprawka:* w 0.2 zdefiniować miarę jako wszystkie zadania main thread w oknie scenariusza, z zamkniętą listą wyjątków i liczbowym progiem na Commit, UpdateLayoutTree, `Layout.totalObjects` oraz nodes.
- Metryki liczą dziś skrypty Pythona w `/tmp`, poza repo. *Poprawka:* w 0.1 dodać wersjonowany parser trace (obok istniejącego `scripts/measure-ui-freeze-baseline.mjs`) z tymi samymi definicjami dla „przed” i „po”.
- Nie określono, kto i jak zbiera trace. 0.1 i 5.2 wymagają żywego UI z prywatnymi danymi i logowaniem, czego agent nie zrobi sam. 5.2 ma bezpiecznik („nie zamykać jako potwierdzony”), a 0.1 — pierwszy liść sekwencji — nie ma. *Poprawka:* w 0.1 i 5.2 zapisać metodę (trace DevTools nagrany przez użytkownika albo Playwright/CDP tracing na zasianym czacie-fixture), kategorie, zestaw danych i regułę „brak trace = liść czeka na człowieka”. Dla 0.1 dopuścić zamknięcie na istniejącym trace z 15:13 plus fixtures syntetyczne.

## Nieblokujące

**N1 (średnia) — 3.1 ma niepełny zakres.** `accumulateStreamText` jest też używane w `sdk-plan-text.js:81` i `lib/todo-plan-sync.js:68`, a `readCurrentRunAssistantText` (`todo-plan-sync.js:100-105`) wybiera „bogatszy” z tekstu pokoju i historii. Nie sprawdzałem, czy „bogatszy” znaczy dłuższy — jeśli tak, rozdęty tekst może wygrać. Brakuje też ustalenia, który harness wytworzył raport i czy jego zdarzenia niosą id wiadomości (adapterów jest około ośmiu). *Poprawka:* dopisać wszystkie cztery wywołania, tabelę semantyki delta/snapshot per harness jako pierwszy krok oraz rozważyć reużycie `lib/sdk/sdk-history-stream-coalesce.js` — zapisana historia childa ma poprawne 4361 B.

**N2 (średnia) — flagi widoku przeciekają przez yield.** `suppressHistoryPersist`, `suppressHooksPlain` i `mdRenderImmediate` są ustawione na cały czas async replayu. `completeSdkHistoryHydration` (`chat.js:5032`) opróżnia kolejkę live zaraz po synchronicznej części, więc zdarzenia live trafiają w środek replayu z wyłączonym persist i hookami. Plan 1.1/1.3 mówi o `finally` i kolejności, nie o tym. *Poprawka:* w 1.3 wymagać flag o zasięgu paczki albo generacji oraz tego, by `completeSdkHistoryHydration`, `armOlderSdkHistory` i `syncRichViewPlainBuffer` czekały na zakończenie replayu.

**N3 (średnia) — generacja musi objąć pozostałe pętle.** `appendHistoryRecords` (`:5291-5337`, yield co 10, to samo `finally`), `applyAgentMessagesHistory` i prepend używają tych samych flag. Istnieje już `captureViewApplyToken` w `chatHistoryViewApply.js` oraz `createSliceSession`/`forEachInTimeSlices` w `schedulerYield.js`. *Poprawka:* 1.1 ma wskazać jeden mechanizm generacji i listę objętych pętli, zamiast tworzyć trzeci.

**N4 (średnia) — wehikuł testów DOM.** Repo nie ma jsdom; `createSdkRichView` uruchamia tylko harness Playwright `tests/chat-history-sync-e2e`. Recenzent liścia nie może uruchomić npx. Rejestrację w review-verify plan przewiduje dopiero w 5.1. *Poprawka:* w 1.1, 2.1 i 4.x wskazać wehikuł (wydzielony czysty moduł schedulera testowany w node plus harness Playwright uruchamiany przez hosta) i rejestrować testy w katalogu w tym samym liściu.

**N5 (średnia) — eviction w 4.2 a deduplikacja.** `runViewApplyWithOrder` deduplikuje przez `findStreamChildByOrderKey`, czyli po obecności w DOM; mapy runów i `planByCallId` trzymają elementy. Po usunięciu węzłów catch-up może wstawić rekord ponownie. *Poprawka:* w 0.2 i 4.1 wymagać tożsamości i deduplikacji niezależnych od zamontowanego DOM przed wprowadzeniem eviction.

**N6 (niska) — decyzja replace/merge local→HTTP** jest odroczona do implementacji 1.3. Druga pełna podmiana zachodzi tylko bez watermarków (`chat.js:4220`). Lepiej rozstrzygnąć w 0.2, bo wpływa na 1.1 i 1.2.

**N7 (niska) — klient nie ograniczy payloadu.** Serwer rozszerza tail=80 do tury (`chat-history-persist.js:496`), stąd 508 rekordów i 786 KB. Zapis „nie zmieniać arbitralnie pagera” jest w porządku, ale koszt parsowania i IDB zostaje — warto odnotować jako ograniczenie albo osobne Todo.

**N8 (niska) — „około 8 ms” nie jest kryterium.** Jeden rekord może przekroczyć budżet. *Poprawka:* p95 i max z wyjątkiem dla pojedynczego niepodzielnego rekordu, mierzone w 0.2.

**N9 (niska) — dostęp do pełnych raportów (3.2).** Kierunek jest dobry, bo rozwinięcie też ma limit. Doprecyzować, że „kopiuj całość” bierze dane źródłowe, a nie DOM, i że dwa mailboxy plus delegacja z tą samą treścią (seq 5319/5320/5524) nie materializują jej wielokrotnie.

## Ocena przekrojowa

Kolejność „correctness przed optymalizacją” (1→2) jest słuszna, a etapy 4 i 5 są właściwie umiejscowione. Ochrona offline/IDB/pollingu, brak kasowania danych oraz semantyka historySeq/roomEventSeq są ujęte. Liście etapu 1, 3.1, 3.3 i 4.1 da się zamknąć niezależnie; 2.1/2.2 nie (B1), a 0.1/5.2 zależą od człowieka (B2).

## Testy, odstępstwa, ograniczenia

- Testów projektu nie uruchamiałem — to audyt szkicu. Weryfikacja objęła odczyt kodu i przeliczenie trace przez jq.
- Nie odtwarzałem próbek profilu CPU (12,45 s inclusive, 7,4 s capture) ani nie czytałem zapisanej historii czatów (zakaz), więc 800 184 B i 4361 B przyjmuję z diagnozy.
- Ścieżki z zadania `lib/harness-plan-sync.js` i `lib/cursor-agent-sdk-ws.js` nie istnieją; właściwe są w `lib/sdk/`.
- Tryb tylko do odczytu zachowany: bez edycji plików, Todo i statusów, bez dalszych delegacji. Artefaktów brak.

TASK: audit
VERDICT: FAIL

## Pełny raport Groka 4.7

Audyt planu 33e307a2-741d-4ec1-94d4-2aa0a94616bb (rev. 2026-10-06T13:49:49.769Z). Plan wczytany do końca (kursory 4000, 8000, 12000 = pusto). 6 etapów, 14 liści, run_mode sequential, status idea. Werdykt planu: FAIL.

## Potwierdzone

Diagnoza w docs/ui-freeze-trace-2026-10-06.md opisuje aktualny kod, z drobnym dryfem linii kart:

- replayHistoryRecords (sdk-rich-view.js:5257) span history.replay zamyka po co najwyżej 20 rekordach, potem void replayHistoryRecordsChunkedImpl co 8 rekordów i rAF (4528–4551). instant:true przy długości >20 i tak nie jest synchroniczne (5267). structuredReplayDone i replaceViewAppliedRecords idą od razu (chat.js:4201–4205 i 4232–4235).
- destroy (4724) nie przerywa pętli. finally replayu (4543 i 5278) zdejmuje suppress* i woła scrollToBottom.
- captureInsertScroll (1536) robi getBoundingClientRect; runViewApplyWithOrder (3598) woła je przy wstawieniu przed istniejące dziecko i izoluje stan na jeden rekord.
- accumulateStreamText (sdk-plan-text.js:13–20) dokleja tekst, gdy snapshot nie jest prefiksem całego akumulatora runu. Wywołania: harness-plan-sync.js:64, cursor-agent-sdk-ws.js:1934 (tylko type===assistant). delegation-run-bridge.js:64–77 publikuje room._currentRunAssistantText jako raport. renderHistoryCardProse (3822) wstawia pełny Markdown delegacji (3906) i mailboxa (4203).
- selectTurnAlignedHistoryWindow (sdk-history-turn-window.js:63) cofa cięcie do user turn bez limitu; brak granicy zwraca całą listę. Serwer ma osobny cap HISTORY_PULL_MAX_LIMIT=2000.
- bumpViewApplyGeneration jest tylko w resetViewAppliedState (chatHistoryConvergence.js:436), więc drugi replay tego samego widoku nie unieważnia catch-upu.
- schedulerYield oddaje scheduler.yield / MessageChannel / setTimeout, ma createSliceSession i budżet 8 ms. Poprzedni odbiór (ui-freeze-final-acceptance) sam przyznaje brak trace produkcji. Etap 5.2 słusznie odmawia PASS z samego harnessu.

Kolejność 0→1 (poprawność) →2 (layout) →3 (raport) →4 (okno) →5 (Chrome) jest właściwa. Offline first paint, dedup, grupy Activity i brak kasowania raportów są w tekście.

## Bloker

Waga: wysoka. Liście 1.1 i 2.2 zamykają się na pętli replayu 8/20 i nie obejmują ścieżki, którą idzie HTTP po lokalnym hydracie.

Gdy structuredReplayDone jest już true i są watermarki, mergeServerSdkHistoryIntoRichView (chat.js:4220) woła applyCatchUpSdkHistoryRecords. Ten woła view.appendHistoryRecords(missing, {instant:true}) (chatHistoryViewApply.js:95–100). Przy instant pętla (sdk-rich-view.js:5291–5316) nie yielduje wcale, a jej finally i tak zdejmuje flagi i może scrollować. Live idzie tą samą funkcją (applyLiveServerHistoryCards, :128). Istniejący token widoku nie rośnie przy nowym replayHistoryRecords.

Test „jeden replay A→B / destroy” z 1.1 przechodzi, a catch-up w tym samym mount dalej rysuje w stary finally i w jednym synchronicznym zadaniu. Budżet 2.2 (≤8 ms / ≤50 ms, schedulerYield) dotyczy paczek 8/20, więc też tego nie złapie. Jeden applyHistoryRecord z pełnym Markdownem i tak przekracza budżet między rekordami — yield jest dopiero po rekordzie.

Poprawka planu: w 1.1 jedna generacja widoku obejmuje replayHistoryRecords, chunked impl, appendHistoryRecords, ich finally i rAF scroll/Markdown. Nowy replay i destroy podbijają ją razem z bumpViewApplyGeneration. Test: replay A, w trakcie catch-up/live, potem replay B i destroy; stary finally nie czyści flag B i nie woła scroll. W 2.2 ten sam budżet czasu dla appendHistoryRecords, także gdy instant:true; rekord cięższy niż budżet jest albo obciętym podglądem, albo jawnym wyjatkiem do 3.2, zapisanym w 0.2.

## Nieblokujące

1. Średnia. 2.2 ma wyjątek „800 KB dopiero w etapie 3”, a korzeń mówi, że ogromna karta nie omija limitów. 0.2 niech zapisze: ≤50 ms etapu 2 obowiązuje na fixtures z prozą już w limicie podglądu; scenariusz 800 KB i Commit rozlicza 3.2 oraz 5.2. Inaczej 2.2 albo się nie domyka, albo domyka się bez dominującego kosztu z trace.
2. Średnia. 0.2 niech ustali coverage: viewAppliedSeq / replaceViewAppliedRecords tylko po faktycznie zastosowanej paczce zamontowanych rekordów. Reszta okna zostaje stronicowalna, bez ACK jako wyrenderowana i bez statusu missing. Zdanie 4.1 „nie zmieniać ACK” ma znaczyć „nie ACK-ować całej strony serwera do 2000”.
3. Średnia. 3.1 zostawia accumulateStreamText dla delty wewnątrz jednego itemu. tests/sdk-plan-text.test.js wymaga Hello + world = Hello world. Osobny tekst na wiadomość/item; kształt snapshot vs delta wpisać dla Cursora i captureHarnessPlanFromSdkEvent. Regresja komentarz→R/Ra/Rap/Raport jest trafna i nie kasuje legalnego powtórzenia.
4. Niska. 3.2: pełna treść przez już autoryzowany payload czatu (kopia ze stringa źródłowego). Nowy URL pliku zostałby w tej samej autoryzacji czatu.
5. Niska. 2.1: jedna kotwica na paczkę i jeden stan renderu dla ciągu tej samej tury. Prepend już składa offscreen (4486) i nie mierzy geometrii, bo findInsertBeforeChild wymaga realStream. Izolacja per rekord (3608) rozcina Activity/Thinking.
6. Niska. 4.1 zmieni kontrakt testu sdk-history-turn-window.test.js:87–90 (brak user turn = cała lista). Fixtures 500/2000 są adekwatne do capu serwera.
7. Niska. W 0.2 sidebar ≤50 ms to task z style/layout/Commit po budżecie DOM. Diagnoza: sam JS open/pin jest krótki, a koszt siedzi w drzewie dokumentu.
8. Niska. Generację wziąć z createSliceSession albo z istniejącego view-apply token, żeby nie prowadzić dwóch liczników.

## Odbiór i niezależność liści

Po dopisku blokera liście domykają się sekwencyjnie: 0.2 jest kontraktem dla 1.2, 2.2, 3.2 i 4.1; 5.2 jest jedynym PASS całości. Sam JS/harness tego PASS nie daje — plan to już mówi. Polling/IDB/archiwum są w 5.1 i 5.2 jako regresja, nie jako główna przyczyna tego trace.

## Testy i ograniczenia

Testów nie uruchamiano: w tej sesji nie ma narzędzia shell. Kontrakty odczytane z tests/sdk-plan-text.test.js i tests/sdk-history-turn-window.test.js. Trace JSON nie był agregowany (python zabroniony, brak shell). Czasy 3361 ms, 789 layoutów i 800184 B zostają pomiarami dokumentu, nie tego audytu. Prywatnej historii czatów nie czytałem. Brak edycji, commitów i delegacji.

Odchylenie: brak. To przegląd szkicu, bez TODO EXECUTION WORKFLOW.

TASK: audit
VERDICT: FAIL

