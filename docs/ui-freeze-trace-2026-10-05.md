# Zawieszanie Cretli — analiza trace i plan naprawy

Data analizy: 2026-10-05. Zakres: diagnoza i plan, bez zmian implementacji.

## Wynik

Główna blokada UI wynika z mnożenia kosztownych operacji w pollingu historii:
każda zmiana `_pendingRemoteHistory` odświeża listę i ponownie buduje cache
startowy całej listy. Przy ponad 300 czatach budowanie cache uruchamia sortowanie,
którego komparator wielokrotnie odczytuje i parsuje mapy aktywności z localStorage.
W nagraniu ta kaskada blokuje główny wątek przez **co najmniej 11,21 s**.

Osobny, wcześniejszy problem: odbiór `sidebarLayout` powoduje pełne wymuszone
przebudowy sidebara i synchroniczny layout. To wyjaśnia krótsze przycięcia,
ale nie jest dominującą przyczyną końcowej blokady.

## Materiał i metoda

- Zrzut: `data/uploads/54fd0aa1-acce-4827-96c1-da34d2d9dd09.jpg`.
- Unpacked trace: `Trace-20261005T225710.json` (local temp unpack, not in the repo).
  Ścieżka przekazana przez użytkownika jest w WSL katalogiem z plikiem o tej samej nazwie.
- 397 580 zdarzeń; 130 943 próbki CPU; 4 544 węzły profilu.
- Renderer: PID 44408, główny wątek TID 66256. Chunks profilu CPU zapisano na
  TID 55844; połączono je z `Profile` przez PID i identyfikator `0x1`.
- Czasy poniżej liczone są od `TracingStartedInBrowser`, ts=219601559746 µs.
  Oś zrzutu DevTools może używać innego punktu zerowego.
- Czas funkcji oszacowano z próbek CPU i `timeDeltas`. Czasy inclusive zawierają
  dzieci, dlatego nie należy sumować wierszy tabeli.
- Sprawdzono również aktualny kod. Numery linii runtime różnią się od bieżących
  plików; katalog roboczy zawierał liczne wcześniejsze zmiany.

## Dowody z nagrania

W t=37,2229 s wychodzi `GET /api/chats/agent-states`; odpowiedź kończy się
w t=37,2336 s. W t=37,2398 s wychodzi `GET /api/chats/history-revisions`;
odpowiedź kończy się w t=37,2470 s. Następnie, w t=37,247032 s, zaczyna się
`RunTask` / `RunMicrotasks`, które nie mają zakończenia przed końcem nagrania
w t≈48,455 s. Obie odpowiedzi dotarły przed blokadą. Ich rozmiary po
rozpakowaniu to odpowiednio 189 165 i 179 166 bajtów.

| Operacja w oknie blokady | Szacowany czas CPU |
| --- | ---: |
| Całe okno próbek | 11 201 ms |
| `runChatHistoryRevisionPoll → setChatPendingRemoteHistory → renderChatList` | 11 135 ms |
| `persistChatListBootCache → writeChatLocalBootCache` | 10 506 ms, ok. 94% okna |
| `selectChatsForBootCache` | 10 415 ms |
| `getChatUpdatedAtMs` wywoływane z komparatora | 9 966 ms |
| `readObjectMap`, czas własny obu map łącznie | 6 765 ms |
| `parseIsoMs`, czas własny | 1 660 ms |
| Odświeżanie etykiet modelu | 406 ms |

Łańcuch wykonania:

```text
runChatHistoryRevisionPoll
  → setChatPendingRemoteHistory(chat, true)
    → onPendingHistoryChange
      → renderChatList
        → chatView.renderChatList → refreshModelSelectLabels
        → persistChatListBootCache
          → writeChatLocalBootCache → buildChatLocalBootCache
            → selectChatsForBootCache → sort(comparator)
              → getChatUpdatedAtMs → getChatActivityAt
                → readChatActivityMap + readChatLastUsedMap
                  → localStorage.getItem + JSON.parse
```

W tym oknie występują **1 364 zdarzenia ParseHTML**: 682 z
`renderModelSelectOptions` i 682 z `_renderPanelItems`. Powtarzające się grupy
czterech parsowań odpowiadają **341 odświeżeniom selektora**; ich stosy prowadzą
do ustawienia pending na `true` w pętli pollingu. To wielokrotne odświeżanie
również zamkniętego formularza nowego czatu.

Nie ma dowodu na pętlę nieskończoną: widoczny kod iteruje po skończonej liście
`monitoredChats`. Nagranie urywa się w trakcie tej pracy, więc 11,21 s jest
dolną granicą czasu zastoju. Samo przeniesienie operacji do Promise/mikrozadania
nie zwolni wątku UI.

## Miejsca w bieżącym kodzie

- `app_front/features/chat/chatHistorySyncPoll.js:149`: zmiana pending natychmiast
  wywołuje callback; pętla `runChatHistoryRevisionPoll` zaczyna się przy linii 579.
- `app_front/chat.js:3048`: callback wywołuje pełne `renderChatList`.
- `app_front/chat.js:3900`: render zawsze uruchamia też utrwalanie cache.
- `app_front/features/chat/chatView.js:340`: odświeżenie listy zawsze odświeża modele.
- `app_front/features/chat/chatLocalBootCache.js:231`: próg >300 włącza sortowanie;
  komparator przy linii 233 liczy aktywność obu czatów przy każdym porównaniu.
- `app_front/features/chat/chatStore.js:11`: każdy odczyt mapy wykonuje `JSON.parse`;
  `getChatActivityAt` odczytuje obie mapy przy każdym wywołaniu.
- `app_front/features/chat/chatLocalBootCache.js:375`: identyczność cache sprawdzana
  jest dopiero po pełnej budowie i sortowaniu. Deduplikacja zapisów nie usuwa kosztu budowy.

## Wcześniejsze przycięcia sidebara

W t≈28,50–30,92 s pięć `socket.onmessage` trwa po 139–163 ms. Profil pokazuje
`onSidebarLayout → applyRemoteSidebarLayout → App.apply → forceRerender → renderPassBody`.
W oknie t≈28,44–31,54 s ta ścieżka ma około 975 ms inclusive; odczyty `scrollTop`
wewnątrz niej zajmują około 352 ms i wskazują na koszt wymuszonego layoutu.

- `app_front/features/sidebar/sidebarLayoutSync.js:180` odrzuca tylko starszy
  timestamp; równy timestamp może być ponownie zastosowany.
- `app_front/App.js:550` bezwarunkowo wywołuje `sidebarView.forceRerender()`.
- `app_front/features/sidebar/sidebarView.js:2676` czyści sygnaturę i mapę reuse,
  więc kolejne komunikaty omijają istniejącą optymalizację ponownego użycia DOM.
- Getter `scrollTop` odczytywany jest również po mutacjach DOM.

Trace potwierdza wielokrotne kosztowne zastosowania layoutu. Nie zawiera treści
ramek WS, więc identyczność payloadów oraz dostarczanie tego samego komunikatu
kilkoma socketami należy potwierdzić w regresji/instrumentacji.

Liczba węzłów DOM osiąga 133 231, heap 79,69 MB. Globalne maksimum 9 660
listenerów pochodzi z dokumentu sprzed reloadu; w końcowej blokadzie jest ich
około 1 783–2 123. To sygnały dużego kosztu przebudowy i alokacji,
a nie samodzielny dowód trwałego wycieku.
W końcowej blokadzie MinorGC zajmuje łącznie około 36 ms; dominują obliczenia
i parsowanie map, a nie GC. Rozszerzenia nie występują w dominującym stosie CPU.

## Dodatkowe potwierdzenie mechanizmu

Uruchomiono bieżący `buildChatLocalBootCache` w Node z syntetycznymi czatami,
licznikiem `Storage.getItem` i dwiema mapami po 1 500 wpisów:

| Liczba czatów wejściowych | Odczyty storage na jedną budowę | Czatów w cache |
| --- | ---: | ---: |
| 300 | 0 | 300 |
| 301 | 2 856 | 300 |
| 1 000 | 17 664 | 300 |
| 1 500 | 32 368 | 300 |

Ponowny zapis identycznego cache dla 1 000 czatów: **0 zapisów**, ale nadal
**17 664 odczyty**. To potwierdza gwałtowną zmianę zachowania po przekroczeniu
300 oraz zbyt późne sprawdzanie identyczności. Dane są syntetyczne; liczników
ani czasu tego eksperymentu nie należy utożsamiać z wielkością listy w trace.

## Plan naprawy, w kolejności realizacji

Aktualizacja po review Opus 5.5 z 2026-10-05: uwzględniono B1–B5 oraz doprecyzowania zakresu. Raport historyczny: [review planu](ui-freeze-plan-review-2026-10-05-opus55.md). Poprawiony szkic nie ma jeszcze ponownego werdyktu PASS.

Architektura: HTTP/WS/IndexedDB → stan po chat.id i mapy aktywności w RAM → zbiorcze aktualizacje zmienionych elementów. Jedna kolejka utrwalania działa niezależnie od renderu; P0 używa legacy, P1 podmienia backend na IndexedDB. Sidebar migruje stopniowo do Lit w **light DOM**, zgodnie z istniejącymi selektorami i globalnym CSS. Archiwum jest wirtualizowane, a hydratacja i pozostałe długie operacje korzystają ze wspólnego helpera scheduler.yield z fallbackiem do nowego taska. Historia SDK ma odrębny lifecycle; migracja metadanych nie kasuje jej jako skutku ubocznego.

## Podział etapów na zadania w Todo

Root Todo: `dcff651f-10b4-4ef0-bc41-1f705f8583dc`. **9 etapów i 26 podzadań wykonawczych**, numeracja etapów 0–8. Kolejność jest sekwencyjna na obu poziomach. Zachowano identyfikatory istniejących zadań; przeniesiono helper przed IndexedDB, końcowe strojenie do odbioru oraz rozbito migrację Lit. Każdy liść obejmuje odpowiednie regresje i niezależne review. Statusy pozostają szkicami, aktualizacja nie uruchamia wykonawców.

| Podzadanie | Zakres | Todo ID |
| --- | --- | --- |
| 0.1 | Dodać instrumentację i zapisać baseline | `548f4b02-1eed-4ac0-8379-a138dc43b4b5` |
| 1.1 | Ujednolicić setter pending i liczyć zmiany netto | `99bf57a2-5122-4f55-ad7a-487718b6898f` |
| 1.2 | Patchować pending w otwartym modalu bez pełnego renderu | `006b84eb-4cd7-4408-9a32-2fb558bffd80` |
| 2.1 | Utrzymywać RAM i kontrakt adaptera trwałości | `1968b808-bb3b-4737-8619-d9c77d733325` |
| 2.2 | Sortować po przygotowanych kluczach równoważnych legacy | `c977593b-98ef-47f3-92a6-cdd9f1ca9828` |
| 2.3 | Odłączyć cache od renderu i utworzyć wspólną kolejkę | `cf23f060-1293-45b8-a6f9-b7c41db4d3c6` |
| 3.1 | Zmierzyć przyczyny monitoringu i ograniczyć archiwum | `ab5a3854-e5dc-4b89-9724-f205932a86b1` |
| 3.2 | Zachować jawne IDs w dużych żądaniach rewizji | `ac79bdf4-9d73-47d8-8c18-7b8e94cd61fb` |
| 3.3 | Zmierzyć i odebrać P0 przed migracją P1 | `bab1a50b-b3d9-4d10-a988-186c2aeb5a02` |
| 4.1 | Dodać helper scheduler.yield z fallbackiem i anulowaniem | `f96ccb7b-233f-44c4-971e-cdeaa8b8f76d` |
| 5.1 | Wdrożyć schema IDB, izolację i epokę sesji | `48e15178-aae0-49a7-a7ce-5f5fb388299a` |
| 5.2 | Podmienić backend wspólnej kolejki na IndexedDB | `a2a9bc0d-abaf-47a7-871c-5fb823cc2f29` |
| 5.3 | Migrować legacy i zapewnić ograniczony bootstrap offline | `778a19d0-e6c5-4555-a941-233ec5b689da` |
| 5.4 | Synchronizować zmiany między kartami bez ping-pongu | `13f50004-0aba-4721-9a8f-691951d9775e` |
| 6.1 | Deduplikować layout i lokalne wymuszone renderowanie | `3e9cbde4-1f42-466d-aee7-896c537aa32d` |
| 6.2 | Ustalić kontrakty migracji Lit w light DOM | `ad2eca0e-62c0-4a1d-9806-4804562dce97` |
| 6.3 | Wprowadzić reaktywny komponent wiersza czatu | `1918122c-2c9b-4837-b53f-fda3811aba9d` |
| 6.4 | Renderować grupy i workspace przez Lit repeat | `615a9264-c9b8-4526-89d9-b80ce12d7d88` |
| 6.5 | Usunąć stary renderer i migrować testy sidebara | `511335ee-87d2-41d2-bbd8-6d9ad7054b87` |
| 6.6 | Zweryfikować interakcje i cykl życia sidebara Lit | `6e5993ca-9e57-49f6-8805-3be94f499f07` |
| 7.1 | Ustalić świeżość pobrań i źródło danych archiwum | `182dec72-f507-43b0-97b9-7dc1006deadd` |
| 7.2 | Wirtualizować archiwum ze stabilnymi ID i budżetem DOM | `b843452c-58d1-4246-b2f0-1b1ac253921b` |
| 7.3 | Zachować dostępność, fokus i gesty w wirtualnej liście | `9f60d624-d066-425c-afdc-055fb25d3ce6` |
| 8.1 | Dostroić porcjowanie pozostałych gorących ścieżek | `383ff6dc-8ec4-423a-93a4-5159827f4eed` |
| 8.2 | Zweryfikować integrację archiwum, offline i wielu kart | `2b547216-3226-42e2-a649-b3c6fd9a61f2` |
| 8.3 | Porównać trace końcowy z baseline i odebrać całość | `4a66e9c5-947a-4265-b2f4-2d7cf5cc25fb` |

### 0. P0: instrumentacja i pomiar bazowy przed zmianami

Przed pierwszą zmianą zachowania rozszerzyć istniejącą diagnostykę opt-in i nagrać powtarzalny baseline. Utrwalić scenariusz, zbiór danych, urządzenie, wersję kodu oraz budżet pierwszego malowania offline. Nie zbierać treści wiadomości ani innych danych poufnych.

#### 0.1: Dodać instrumentację i zapisać baseline

Dodać spany history.poll.apply, boot-cache.build i sidebar.layout.apply oraz liczniki: zmiany netto pending, odświeżenia UI, storage reads, cache builds/writes, force renders, zamontowane wiersze, czas porcji. Rejestrować przyczyny kwalifikacji do monitoringu (active/recent/live/busy/waiting/attention) z podziałem na archivedAt. Nagrać reload → archiwum → co najmniej 20 s do pollu → input/scroll, także offline cold start. Ustalić liczbowy budżet pierwszego malowania dla małego bootstrapu na tej samej maszynie; zachować trace i parametry powtórzenia.

**Odbiór:** Baseline i tabela metryk dostępne przed 1.1. Diagnostyka domyślnie wyłączona, bez treści czatów. Rozróżnić czas pollu, pełnego renderu archiwum i hydratacji; observer longtask nie jest jedynym dowodem, bo raportuje dopiero po zakończeniu taska.

### 1. P0: zbiorcze zmiany pending i patch otwartego modala

Pending ma plakietkę w modalu listy czatów, a nie w sidebarze. Modele zmieniać natychmiast, powiadomienia UI scalać dla zmian netto batcha. Zachować kontrakt viewAppliedSeq/headSeq, ACK, grace i retry; pending znika dopiero po dogonieniu historii przez widok.

#### 1.1: Ujednolicić setter pending i liczyć zmiany netto

Wspólny setter/publisher obejmuje chatHistorySyncPoll, pushInbox i chatHistoryConvergenceRun. Zapamiętać stan sprzed synchronicznego batcha i publikować tylko różnicę netto; undefined i false traktować równoważnie. Obsłużyć true→false w jednym batchu, await, ACK, retry, błędy i flush przed długim pobraniem historii. Modele aktualizować od razu, małe powiadomienia UI scalać w jednej klatce.

**Odbiór:** Setki rzeczywistych zmian dają najwyżej jeden refresh na synchroniczny batch; brak zmiany netto daje zero powiadomień, także przy identycznym kolejnym pollu. Testy obejmują wszystkie trzy źródła zapisów flagi oraz viewAppliedSeq/ACK/grace/retry.

#### 1.2: Patchować pending w otwartym modalu bez pełnego renderu

Dodawać/usuwać chat-list-item-sync-badge w istniejących wierszach otwartego modala, bez renderChatList. Przy zamkniętym modalu nie wykonywać pracy DOM dotyczącej jego pending; stan ujawniać przy otwarciu. Zaktualizować selektor aktywnego czatu tylko jeśli rzeczywiście prezentuje tę informację. Dla dużego batcha użyć mapy elementów lub jednego przejścia, unikając querySelector per ID po całym drzewie. Nie patchować sidebara wyłącznie z powodu pending.

**Odbiór:** Plakietka otwartego modala jest aktualna bez przebudowy listy. Zamknięty modal: zero pracy DOM z pending. Callback poll→UI: zero cache builds/writes i refreshModelSelectLabels; niezmienione wiersze zachowują tożsamość DOM. Zmierzyć duży batch.

### 2. P0: stan w RAM, ranking bez storage i jedna kolejka cache

Stan po chat.id oraz mapy activity/last-used utrzymywać w RAM; zachować runtime views/sockety i semantykę rankingu. Hydratacja storage tylko na start/unieważnienie. Jedna kolejka utrwalania i interfejs adaptera powstają w P0, a etap 5 podmienia backend na IndexedDB. Cache budować po zmianach danych, nie po renderze lub pending; cap boot cache 300, active i watcherPinned pozostają.

#### 2.1: Utrzymywać RAM i kontrakt adaptera trwałości

Podłączyć stan po chat.id oraz mapy aktywności/last-used w RAM, aktualizowane przez lokalne zdarzenia i HTTP/WS. Zachować tożsamość obiektów czatów/views/socketów. Hydratować legacy raz; obsłużyć unieważnienie przez storage z innych kart i reset sesji. Scalić aktywność per klucz przez max timestamp, zamiast nadpisywania całych map. Przycinanie do znanych ID dopiero po pełnym autorytatywnym indeksie, nie po ograniczonym boot snapshotcie. Zdefiniować wspólny interfejs trwałości i generację sesji używane przez kolejkę 2.3.

**Odbiór:** Lokalna i cross-tab aktywność aktualizują ranking bez parsowania map per czat. Render i komparator nie czytają storage. Reset sesji odrzuca stare dane, częściowy indeks nie usuwa aktywności jeszcze niewczytanych czatów.

#### 2.2: Sortować po przygotowanych kluczach równoważnych legacy

Boot-cache i selekcja monitoringu/socketów obliczają liczbowy klucz raz na czat z RAM. Dla cache wynik ma być równoważny dzisiejszemu getChatUpdatedAtMs na wierszach po sanityzacji. Zachować remisy, cap, active/watcherPinned; nie zmieniać sortowania UI po dacie utworzenia.

**Odbiór:** Dla 300/301/1000/1500 czatów: zero storage reads w komparatorze, klucz raz na wiersz, kolejność i wymagane rekordy równoważne legacy. Zmiana aktywności zmienia ranking zgodnie z kontraktem.

#### 2.3: Odłączyć cache od renderu i utworzyć wspólną kolejkę

Dirty/revision sprawdzać przed budową snapshotu. Kolejka scala rzeczywiste zmiany metadanych, aktywnego czatu/workspace/rankingu, ma ograniczony czas odroczenia i generację sesji; logout/401 unieważnia ją już w P0. Utrzymać działający backend legacy, który 5.2 zastąpi IDB bez tworzenia drugiej kolejki. Utrwalać na bieżąco; flush pagehide/hidden jest tylko dodatkową próbą.

**Odbiór:** Powtarzany render i pending nie budują ani nie zapisują cache. Wiele zmian trwałych daje scalony zapis; bez zmian zero budów. Zaległa kolejka po logout/401 nie odtwarza cache. Offline boot zachowany, poprawność nie zależy od zakończenia flush przy zamykaniu.

### 3. P0: monitoring archiwum, jawne IDs i odbiór pollingu

Najpierw zmierzyć faktyczne powody kwalifikacji na danych runtime. Zaległe waiting/attention jako źródło nadmiernego monitoringu to hipoteza, nie wynik trace. Jawna polityka archiwum: monitorować aktywny czat albo rzeczywiście działający agent/run; sam stan waiting/attention lub recent nie wystarcza dla archiwalnego czatu. Zachować live monitoring poza viewportem i poprawną presence. Po 3.2 wykonać osobny odbiór P0 przed P1.

#### 3.1: Zmierzyć przyczyny monitoringu i ograniczyć archiwum

Wykorzystać liczniki 0.1 dla active/recent/live/busy/waiting/attention × archivedAt na realnym zbiorze. Sprawdzić hipotezę globalnego agent-states nadającego nieaktywne waiting/attention archiwum. Kwalifikować archiwalny czat wyłącznie gdy aktywny lub ma faktyczny run, z użyciem hasActiveAgentRun po sprawdzeniu kontraktu; nie utożsamiać samego nie-idle stanu z trwającą pracą. Otwarcie archiwum nie może rozszerzać monitoringu zaległych stanów.

**Odbiór:** Raport przyczyn przed/po na realnych danych i regresja 1500/1200 archived. Archiwalne idle/zaległe waiting/attention nie kwalifikują; aktywny czat i rzeczywiste runy poza viewportem pozostają monitorowane. Jeśli kontrakt run nie pozwala rozróżnić stanów, opisać i uzupełnić go w tym zadaniu.

#### 3.2: Zachować jawne IDs w dużych żądaniach rewizji

Zastąpić fallback >2048 znaków kontrolowanymi partiami albo jawnym POST. Wykorzystać wzorzec history-batch/listExplicitScopedChatIds, gdzie brak IDs jest błędem, a nie zgodą na cały indeks. Zakres obejmuje klienta, serwer i allowlistę lib/widget/widget-http.js; zachować scoped dostęp i kompletne scalanie odpowiedzi. Globalny agent-states mierzyć osobno; nie zmieniać jego celowego zakresu bez zachowania gap/watermark/presence.

**Odbiór:** Granica 2048 znaków nie usuwa filtra; każde wymagane ID obsłużone, liczba partii i rozmiar żądań ograniczone. Regresje scoped/widget access i scalania wyników; presence gap/watermark pozostają poprawne.

#### 3.3: Zmierzyć i odebrać P0 przed migracją P1

Powtórzyć scenariusz 0.1 na tych samych danych/urządzeniu. Porównać poll, cache builds/reads i powody monitoringu; zapisać trace i raport. Wyodrębnić taski pollu od nadal pełnego renderowania archiwum. W razie nieosiągnięcia kryteriów poprawić P0 przed etapem 4.

**Odbiór:** Najwyżej jeden refresh na synchroniczny batch pending; zero cache builds/writes wyłącznie z pending, zero storage reads w renderze/komparatorze. Żaden task naprawionej ścieżki pollu nie przekracza 50 ms. Cel ≤50 ms dla otwarcia całego archiwum obowiązuje dopiero po etapie 7; znany koszt pełnego renderu opisać w raporcie P0.

### 4. P1: helper porcjowania przed hydratacją IndexedDB

Helper przygotować po odbiorze P0, przed hydratacją w 5.3 i 7.1. Wykrywać scheduler.yield; fallback oddaje sterowanie do nowego taska, preferencyjnie MessageChannel, z setTimeout jako ostatnią ścieżką. Nie zakładać wsparcia API na podstawie nazwy przeglądarki. Docelowy budżet porcji około 8 ms, kalibrowany pomiarem.

#### 4.1: Dodać helper scheduler.yield z fallbackiem i anulowaniem

Wprowadzić pomocnicze porcjowanie według czasu (~8 ms), feature detection scheduler.yield, fallback MessageChannel/setTimeout do nowego taska. Promise.resolve nie zwalnia UI. Obsłużyć generację/revision, anulowanie i cleanup kanałów. Każda kontynuacja przed zastosowaniem wyniku sprawdza aktualność. requestAnimationFrame służy małym zapisom DOM; poprawność nie zależy od uruchomienia kontynuacji w ukrytej karcie.

**Odbiór:** Input/timery wykonują się między porcjami. Wymuszone ścieżki scheduler i fallback dają takie same dane/kolejność; anulowana kontynuacja nie stosuje starego wyniku. Test powrotu z tła i cleanup. Helper gotowy przed 5.3 i 7.1.

### 5. P1: IndexedDB z izolacją, epoką sesji i bootstrapem offline

Bieżące dane pozostają w RAM; IDB przechowuje whitelistę bezpiecznych metadanych, archiwum i mapy aktywności, bez views/socketów/DOM. W 5.1 ustalić tożsamość cache na podstawie kontraktu serwera albo jawny reset cache metadanych przy granicy sesji. Nie zakładać istniejącego user ID ani bez decyzji kasować historii SDK. Generacja/logout/401 obowiązują przed kolejką i hydratacją. Testy prawdziwego IDB w istniejącym Playwright.

#### 5.1: Wdrożyć schema IDB, izolację i epokę sesji

Sprawdzić model auth serwera i zapisać konkretny kontrakt izolacji: stabilny identyfikator konta/cache scope albo reset nowego cache metadanych przy logout/401 i granicy sesji. Określić osobno lifecycle map aktywności i istniejącej bazy cretli-sdk-chat; nie usuwać historii SDK jako ubocznego skutku migracji. Wdrożyć generację sesji z 2.3 dla wszystkich operacji IDB i reset RAM już tutaj. Schema po ID, indeksy workspace/archived/ranking, whitelist, limit/retencja niezależne od boot snapshotu; odczyt archiwum należy do 7.1. Obsłużyć quota/niedostępne IDB, versionchange i blocked upgrade. Harness: istniejący Playwright, bez konieczności nowej zależności.

**Odbiór:** Udokumentowana, testowalna izolacja danych oraz zakres lifecycle SDK. Round-trip bez obiektów runtime. W dwóch stronach Playwright: upgrade/versionchange/blocked i abort transakcji; logout/401 podczas operacji nie odtwarza danych starej sesji. Retencja i selekcja zgodne ze schematem.

#### 5.2: Podmienić backend wspólnej kolejki na IndexedDB

Użyć adaptera i jednej kolejki z 2.3, podmieniając backend na IDB. Scalać dirty IDs i ograniczać wielkość transakcji; retry/backoff dla błędów. Epokę z 5.1 sprawdzać przy planowaniu, wykonaniu i zastosowaniu wyników. Zmiana netto aktywności per klucz zachowuje max timestamp; nie przepisywać całej bazy na pending. Zapisywać na bieżąco, pagehide/hidden flush tylko best effort.

**Odbiór:** Seria trwałych zmian daje scalone zapisy odpowiednich rekordów; pending zero transakcji. Abort/quota nie oznacza sukcesu, nowszy rekord pozostaje dirty. Zaległy zapis po logout/401 nie odtwarza cache. Brak IDB reads w renderze/komparatorze.

#### 5.3: Migrować legacy i zapewnić ograniczony bootstrap offline

W localStorage zachować jawny synchroniczny bootstrap: aktywny czat, workspace, watcherPinned i pierwsze N wymaganych wierszy; ustalić i zapisać N oraz limit bajtów według baseline 0.1. Nie blokować pierwszego malowania siecią/IDB. Resztę hydratować asynchronicznie porcjami przez helper 4.1, sprawdzając epokę i revision względem HTTP/WS. Migrować legacy idempotentnie, źródło usuwać dopiero po skutecznym commicie. Przy niedostępnym IDB/quota zachować mały bootstrap i kontrolowaną degradację.

**Odbiór:** Offline cold start pokazuje aktywny czat/workspace przed siecią i przed zakończeniem pełnej hydratacji; pierwsze malowanie mieści się w liczbowym budżecie z 0.1. Bootstrap przestrzega N/limitu bajtów. Przerwana/powtórzona migracja nie gubi źródła, późny IDB nie cofa nowszego HTTP/WS ani stanu po logout.

#### 5.4: Synchronizować zmiany między kartami bez ping-pongu

Dodać transport powiadomień BroadcastChannel z fallbackiem storage, używając już istniejącej epoki z 5.1. Wiadomości zawierają scope/revision/dirty IDs, bez danych runtime. Aktualizować RAM przez adapter, scalać aktywność per klucz max timestamp; nie tworzyć nowej kolejki ani drugiego mechanizmu logout. Starsze lub obce scope odrzucać.

**Odbiór:** Zmiana w drugiej karcie dociera do RAM, bez pętli zapisu/echo. Regresje obu transportów i dwóch kart: kolejność, równoczesne zmiany aktywności, logout/401, późne wiadomości starej sesji. Częściowy indeks nie usuwa niewczytanych rekordów.

### 6. P1: stopniowa migracja sidebara do Lit w light DOM

Sidebar jest dziś imperatywny i ma liczne zewnętrzne selektory oraz globalne style. Plan przyjmuje light DOM dla migracji. Etapy: deduplikacja layoutu, inwentarz kontraktów, komponent wiersza, grupy/workspace, usunięcie starego renderu, weryfikacja interakcji. Każdy krok zachowuje działający sidebar i runtime. Shadow DOM w innych komponentach nie jest podstawą do zmiany render root sidebara.

#### 6.1: Deduplikować layout i lokalne wymuszone renderowanie

Porównywać skuteczne pola layoutu po lokalnych pending, scalać równoważne payloady/self-echo. Zwykły remote apply oraz lokalny toggleArchiveSection nie wymuszają pełnej przebudowy bez potrzeby. W przejściowej implementacji zachować sygnatury/reuse; po 6.5 ich rolę przejmuje Lit. Nie odrzucać równych timestampów bez uwzględnienia częściowych payloadów. Odczyty scroll/pomiary przed mutacjami; pełne odtworzenie dla języka tylko gdy potrzebne.

**Odbiór:** Identical echo z kilku socketów nie przebudowuje DOM; częściowe zmiany i lokalne pending poprawne. Otwarcie/zamknięcie archiwum nie czyści niepotrzebnie reuse. Regresje scroll/focus i języka.

#### 6.2: Ustalić kontrakty migracji Lit w light DOM

Potwierdzić light DOM jako render root. Spisać konsumentów .sidebar-chat-item[data-chat-id]: chat.js updateSidebarChatStates/getRenderedSidebarChatIds, drag/swipe, klawiatura i globalne app.scss. Zdefiniować DOM/event/CSS kontrakt wiersza, grup/workspace oraz granicę mount, tak aby Lit i stary renderer nie zarządzały tym samym poddrzewem. Zaplanować adaptację testów sidebar-signature i sidebar-transient-patch z asercji stringów do zachowania.

**Odbiór:** Zapisany inwentarz i kontrakt migracji bez utraty dostępu selektorów/stylów. Konkretne granice kolejnych 6.3–6.5; nie wprowadzać Shadow DOM do sidebara w tym zakresie.

#### 6.3: Wprowadzić reaktywny komponent wiersza czatu

Komponent Lit w light DOM utrzymuje chat.id/data-chat-id i istniejący kontrakt klas/eventów. Subskrypcje RAM/dirty IDs aktualizują wyłącznie właściwy wiersz; cleanup przy unmount. Zintegrować wiersz z aktualnym renderem przez granicę mount ustaloną w 6.2, zanim migrują grupy.

**Odbiór:** Zmiana statusu zachowuje DOM innych wierszy, grup i workspace. Selektory oraz globalne style działają; model picker nie jest odświeżany. Usunięcie/montaż nie mnożą listenerów, test tożsamości wiersza.

#### 6.4: Renderować grupy i workspace przez Lit repeat

Przenieść grupy/workspace na Lit z repeat i stabilnymi kluczami chat.id/workspace/group. Użyć komponentu wiersza z 6.3 i danych RAM; zachować favorites, kolejność, subchat groups, scroll anchoring i dirty routing.

**Odbiór:** Przestawienie/dodanie/usunięcie wierszy nie odtwarza niezmienionych rekordów. Status nie przebudowuje workspace. Testy kluczy, grup i kolejności; istniejące interakcje zachowane podczas migracji.

#### 6.5: Usunąć stary renderer i migrować testy sidebara

Po integracji Lit usunąć zastąpione HTML stringi/innerHTML, sygnatury i ręczny reuse, pozostawiając jeden właściciel poddrzewa. Przełączyć wszystkie wejścia aktualizacji na Lit. Zmigrować sidebar-signature/sidebar-transient-patch do testów zachowania i tożsamości DOM; zachować diagnostykę oraz ścieżki zmiany języka.

**Odbiór:** Nie ma równoległej starej ścieżki renderowania tych samych grup/wierszy. Testy sprawdzają końcowe kontrakty Lit, pending modal oraz layout, bez polegania na legacy HTML stringach. Status/remote layout nie mnożą listenerów.

#### 6.6: Zweryfikować interakcje i cykl życia sidebara Lit

Dokończyć integrację favorites, grup subchatów, języka, dostępności, focus/scroll i drag/swipe. Sprawdzić cleanup listenerów/subskrypcji przy zmianie workspace i montażu/odmontowaniu. Interakcje mają działać także podczas status updates i remote layout.

**Odbiór:** Regresje klawiatury, drag/swipe/favorites, remote layout, języka i scroll/focus. Powtarzane montowanie/odświeżanie nie zwiększa liczby listenerów; niezmienione DOM zachowuje tożsamość.

### 7. P1: wirtualizacja archiwum i polityka świeżości pobrań

Po P0, helperze i migracji Lit wirtualizować archiwum z ograniczonym zapasem viewportu. Zachować pełne wyszukiwanie, subchaty, focus/scroll, klawiaturę, drag/swipe i dostępność. Istniejący loadChatsFromServer już scala żądania w toku, ale może kolejkować kolejne pełne pobranie — zmienić politykę świeżości, nie tworzyć coalescing od zera.

#### 7.1: Ustalić świeżość pobrań i źródło danych archiwum

Skorygować pendingLoadQuery/loadChatsFromServer tak, aby szybkie ponowne otwarcie korzystało z właściwego wyniku w toku zamiast bez potrzeby kolejnego pełnego GET. Zdefiniować kiedy wymagane jest odświeżenie, z zachowaniem świeżości. Ten liść jest właścicielem odczytu archiwum z RAM/IDB (schema 5.1). Wyszukiwanie obejmuje cały zbiór, także niewidoczne wiersze; hydratację/pobieranie porcjować przez 4.1, stronicować jeśli wykazują to pomiary.

**Odbiór:** Szybkie otwarcia nie powodują zbędnego kolejnego pełnego pobrania; wymagane odświeżenie dociera. Wyszukiwanie znajduje rekordy poza oknem. Stare wyniki po zmianie sesji/revision odrzucane, hydratacja nie blokuje input.

#### 7.2: Wirtualizować archiwum ze stabilnymi ID i budżetem DOM

Wybrać i udokumentować własne okno lub @lit-labs/virtualizer po ocenie zgodności light DOM, zmiennych wysokości i kosztu utrzymania; ocenę i wybór wykonać w ramach tego zadania. Renderować viewport plus ograniczony zapas z kluczami ID, grupami i scroll anchoring. Metadane pozostają RAM/IDB. Określić liczbowy limit zamontowanych wierszy dla testowego viewportu. content-visibility tylko opcjonalnie.

**Odbiór:** Dla 1500 i 10000 czatów liczba zamontowanych wierszy mieści się w ustalonym limicie zależnym od viewportu. Przewijanie/grupy/zmienne wysokości poprawne. Po całym etapie 7 otwarcie archiwum nie tworzy tasków >50 ms na urządzeniu baseline.

#### 7.3: Zachować dostępność, fokus i gesty w wirtualnej liście

Dodać aria-setsize/aria-posinset dla odpowiedniego modelu listy, nawigację do rekordów spoza okna oraz logiczne utrzymanie focus przy unmount. Uwzględnić rozwijanie grup, wyszukiwanie, favorites, zmienne wysokości i scroll anchoring. Określić co dzieje się z drag/swipe przy wyjściu wiersza z okna (utrzymanie lub kontrolowane zakończenie gestu), bez utraty stanu.

**Odbiór:** E2E rekordów poza oknem, klawiatury, grup, otwarcia/zamknięcia archiwum i unmount podczas gestu. Poprawne aria, fokus i scroll; liczba wierszy nadal ograniczona, brak tasków >50 ms podczas otwarcia w scenariuszu baseline.

### 8. P1: końcowe strojenie, regresje i pomiar odbiorczy

Instrumentacja i baseline już istnieją z 0.1, a P0 ma osobny odbiór 3.3. Na końcu dostroić pozostałe gorące ścieżki, sprawdzić integrację i porównać trace końcowy. Testy poszczególnych kontraktów należą do każdego liścia; tutaj sprawdzić współdziałanie. Nowe testy objąć katalogiem scripts/review-verify.js.

#### 8.1: Dostroić porcjowanie pozostałych gorących ścieżek

Po etapach 5–7 użyć pomiarów do podłączenia/dostrojenia helpera 4.1 w pozostałych długich selekcjach, hydratacji i przygotowaniu list. Nie odkładać pierwszego użycia helpera w 5.3/7.1 do tego liścia. requestAnimationFrame tylko dla małych zapisów DOM; odroczenie cache ograniczone, epoka/revision sprawdzane po yield. Worker rozważyć dopiero dla obliczeń nadal dominujących w trace.

**Odbiór:** Porcje około 8 ms kalibrowane pomiarem; brak tasków >50 ms w naprawionych ścieżkach, dane i kolejność równoważne. Wymuszony fallback i anulowanie nie cofają nowego stanu. Raport gorących ścieżek i responsywności.

#### 8.2: Zweryfikować integrację archiwum, offline i wielu kart

Uruchomić regresje i istniejący Playwright E2E: reload, archiwum, >=20 s do pollu, input/scroll, powrót z tła, offline boot, dwie karty, logout/401. Obejmować migrację, abort/quota/niedostępne IDB, blocked/versionchange i wyścigi HTTP/WS. Zarejestrować nowe testy w scripts/review-verify.js z właściwymi selektorami plików, tak aby odpowiednie zmiany uruchamiały właściwe weryfikacje.

**Odbiór:** Active/watcherPinned, live monitoring, viewAppliedSeq/ACK, favorites/grupy/focus/drag/swipe poprawne. Późny cache/wiadomości/kontynuacje nie cofają nowego stanu ani granicy sesji. Wyniki E2E i odpowiedniego review-verify zapisane; pierwsze malowanie offline spełnia budżet z 0.1.

#### 8.3: Porównać trace końcowy z baseline i odebrać całość

Użyć instrumentacji 0.1 i raportu P0 3.3, bez odkładania baseline do końca. Powtórzyć ten sam scenariusz, dane, viewport i urządzenie; zachować trace, tabelę metryk przed/P0/po oraz ograniczenia pomiaru. Zmierzyć czas pollu, otwarcia archiwum, hydratacji, input, DOM window i porcji.

**Odbiór:** Najwyżej jeden refresh na synchroniczny batch pending, zero cache builds/writes z pending, zero storage reads w renderze/komparatorze, ograniczone okno DOM dla 1500/10000 rekordów. Brak sekundowych zastojów i tasków >50 ms w naprawionych ścieżkach, w tym otwarciu archiwum po etapie 7. Budżet pierwszego malowania offline zachowany; odstępstwa i konkretne przyczyny raportowane.

## Kryteria przekrojowe i granice odbioru

- Pending: porównanie netto batcha, wszystkie źródła zapisów przez wspólny setter; plakietka aktualna w otwartym modalu bez pełnego renderu, zamknięty modal bez pracy DOM z pending. Zachować viewAppliedSeq/ACK/grace/retry.
- Cache/RAM: zero odczytów storage/IDB w renderze i komparatorach, zero budów/zapisów z samego pending. Ranking równoważny legacy po sanityzacji; active, watcherPinned i boot cap 300 zachowane.
- Monitoring: realne runy i aktywny czat zachowują obsługę poza viewportem. Zaległe waiting/attention w archiwum nie są same podstawą monitorowania. Hipotezę ich wpływu potwierdzić licznikami na danych runtime.
- IDB: izolacja oparta na sprawdzonym kontrakcie auth, epoka sesji przed kolejką/hydratacją, whitelist i kontrolowana retencja, abort/quota/versionchange/blocked upgrade w Playwright. Brak kasowania historii SDK jako ubocznego skutku zmiany cache metadanych. Źródło migracji usuwać dopiero po commicie; późna hydratacja nie nadpisuje HTTP/WS. Flush lifecycle jest dodatkową próbą, a nie gwarancją zapisu.
- Lit/archiwum: light DOM, stabilne klucze, tożsamość niezmienionych wierszy, cleanup; pełne wyszukiwanie, grupy, klawiatura, aria, focus/scroll i drag/swipe mimo odmontowywania wierszy.
- Odbiór P0 (3.3): taski naprawionej ścieżki pollu ≤50 ms na urządzeniu baseline. Koszt pełnego renderu archiwum ocenić oddzielnie; cel ≤50 ms dla otwarcia obowiązuje po etapie 7 i na odbiorze końcowym.
- Baseline jest nagrany przed 1.1. Parametry N/limit bajtów bootstrapu i liczbowy budżet pierwszego malowania zapisać przed wdrożeniem 5.3; budżet okna DOM zapisać w 7.2. Trace końcowy porównywać na tych samych danych, urządzeniu i viewportcie.
- Scheduler/fallback: pomiary czasu porcji, input pomiędzy nimi, anulowanie po zmianie chat/sesji/revision; poprawność nie zależy od dokończenia pracy w tle. Sama mikrokolejka Promise nie wystarcza.
- Nowe regresje włączyć do scripts/review-verify.js. Każdy liść wymaga odpowiednich testów i niezależnego review; nieoznaczanie szkicu jako wykonanego tylko po aktualizacji planu.

Plan pozostaje szkicem. Implementacja i pomiary odbiorcze są do wykonania.

## Uzupełnienie po niezależnym audycie Opus 5.5

Audyt na `claude-opus-5-5::effort=medium` potwierdził główny stos i liczby
profilu CPU. Pełny raport i uwagi do jego interpretacji:
`docs/ui-freeze-trace-2026-10-05-opus55.md`.

### Potwierdzony wyzwalacz i porównanie w tym samym nagraniu

- W t=28,312 i 30,500 s pobrano `/api/chats?includeArchived=1`, po 911 250 B.
  Następny poll rewizji, w t=37,240 s, wysłał żądanie bez `ids`; odpowiedź
  miała 179 166 B. Wcześniejsze polle w t=8,724 i 22,223 s wysyłały 46 IDs
  i otrzymywały odpowiedzi po 6 133 B.
- `app_front/lib/chatIdsQuery.js` pomija `ids`, gdy niezakodowany ciąg ID
  przekracza 2 048 znaków. Serwer wtedy zwraca wszystkie czaty dostępne
  dla wywołującego. Pominięcie filtra powiększa transfer; sama liczba
  czatów przetwarzanych w UI nadal zależy od lokalnego `monitoredChats`.
- W pierwszym pollu po reloadzie ta sama ścieżka pending produkuje 184
  ParseHTML w około 34 ms, odpowiadające 46 odświeżeniom. W końcowej blokadzie
  średni koszt odświeżenia to około 32,8 ms. To około 44-krotna różnica w tym
  samym trace; profil końcowej blokady potwierdza sortowanie cache.
- Szacunek około 1 300 czatów nie jest odczytem z odpowiedzi. Trace nie zawiera
  treści payloadu, więc dokładna liczba i całkowity czas blokady pozostają nieznane.

### Dodatkowy P0 — ograniczenie monitoringu i zachowanie jawnej selekcji IDs

Przeglądanie archiwum nie powinno automatycznie rozszerzać monitorowania historii
nieaktywnych archiwalnych czatów. Dodać tę politykę w selekcji, zachowując wyjątki
dla aktywnego czatu i żywej pracy/wymaganych interakcji. Nie ograniczać monitoringu
pracującego agenta tylko dlatego, że wiersz jest poza viewportem.

Sama obecność w DOM nie wystarcza dziś do monitorowania: `selectHistoryHttpChatIds`
wymaga także członkostwa w `selectMonitoredChatIds`, który sprawdza aktywność
w ostatnich 10 minutach lub stan aktywnej pracy. Przed implementacją ustalić,
dlaczego po wczytaniu archiwum ten zbiór jest tak duży; wykluczenia archiwalnych
wierszy nie ma w obecnej selekcji.

Duży zbiór IDs dzielić na kontrolowane partie lub przesyłać jawnie w POST,
zamiast zamieniać go na żądanie całego indeksu. Zachować serwerowe ograniczenie
do czatów dostępnych dla wywołującego. Zmierzyć osobno fallback agent-states,
który obecnie jest globalny z założenia; nie zawężać go bez zachowania poprawności
presence, obsługi gap i watermarków.

Regresja: 1 500 czatów, w tym 1 200 archiwalnych; podgląd archiwum nie powiększa
zbioru nieaktywnych monitorowanych czatów. Aktywny czat i żywe runy pozostają
monitorowane. Dla listy IDs >2 048 znaków wszystkie żądania pozostają jawnie
ograniczone, z kontrolowaną liczbą partii.

### Dodatkowy P1 — koszt dużego archiwum i powtórnych pobrań

Uwzględnić stronicowanie lub wirtualizację archiwum jako konkretny etap P1:
115–133 tys. węzłów już powoduje kosztowne przebudowy. Najpierw wdrożyć P0
i deduplikację layoutu, a wynik pomiaru wykorzystać do doboru rozmiaru strony/okna.
Zachować wyszukiwanie, nawigację klawiaturą, focus, scroll i grupy subchatów.
Sprawdzić coalescing pobrań archiwum w toku i zasadność ponownego pełnego pobrania
przy kolejnym otwarciu; dwa żądania w trace nie dowodzą ich równoległości.

Przyrost około jednego listenera na odświeżenie selektora modeli zweryfikować
po zakończeniu taska i GC. To hipoteza wycieku, nie potwierdzony leak.

Audyt uruchomił istniejące `tests/chat-local-boot-cache.test.js`
i `tests/chat-history-sync-poll.test.js`; oba przeszły. Nie obejmują one
liczników odczytów map ani liczby odświeżeń pending, więc nie wykluczają tej regresji.
