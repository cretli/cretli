# Weryfikacja planu przez Opus 5.5 — 2026-10-05

Model: `claude-opus-5-5::effort=medium`. Delegacja: `211c24c7-b30b-48b4-8fcb-e22cd294e4b1`.

Wynik: **FAIL — plan wymaga dopracowania przed realizacją**. Review nie zmieniło kodu ani zadań Todo.

## Weryfikacja uwag w kodzie przez agenta nadrzędnego

Potwierdzono lokalizację plakietki pending w modalu, dodatkowe bezpośrednie zapisy flagi pending, zależność konsumentów sidebara od light DOM, kolejkę ponownego pobrania listy oraz brak czyszczenia bazy SDK w obecnej ścieżce 401. Projekt ma już Playwright, więc testy IndexedDB mogą korzystać z istniejącego narzędzia bez dodawania zależności.

Przyczyna nadmiernego monitoringu archiwum pozostaje hipotezą do sprawdzenia na danych runtime. Zakres izolacji cache i czyszczenia historii SDK wymaga ustalenia w planie; raport nie potwierdza modelu kont po stronie serwera. Zapisy IndexedDB należy wykonywać na bieżąco; flush przy pagehide/hidden jest dodatkową próbą i nie gwarantuje zakończenia transakcji. Twierdzeń raportu o wsparciu scheduler.yield w poszczególnych przeglądarkach nie weryfikowano niezależnie.

## Pełny raport delegacji

# Review planu naprawy zawieszania UI (root dcff651f)

## Ocena

Diagnoza jest trafna i potwierdzona w kodzie, kierunek (RAM → IndexedDB → Lit → wirtualizacja → scheduler) jest spójny. Plan wymaga jednak poprawek przed realizacją: pięć defektów blokuje poprawne wykonanie (B1–B5), reszta to doprecyzowania.

Drzewo Todo odczytałem w całości przez MCP: root (body + plan, 6 stron po 4000 znaków), 8 etapów i 21 liści; żadnego `next_children_cursor`. Pole `plan` roota jest treściowo identyczne z `docs/ui-freeze-trace-2026-10-05.md`. Tytuły i zakresy 21 liści zgadzają się z tabelą w dokumencie; wszystko `idea`, `sequential`, plan niezatwierdzony.

## Co jest poprawne (potwierdzone w kodzie)

- Łańcuch blokady: `chatHistorySyncPoll.js:149-157` → `chat.js:3048` (`renderChatList`) → `chat.js:3900-3904` (`persistChatListBootCache`) → `chatLocalBootCache.js:231-236` → `chatListSort.js:15` → `chatStore.js:11-53` (dwa `JSON.parse` na wywołanie).
- Fingerprint sprawdzany po budowie (`chatLocalBootCache.js:373-384`).
- `buildChatIdsQuery` gubi filtr po 2048 znakach (`chatIdsQuery.js:51`); to tylko ok. 55 UUID.
- `App.js:550` bezwarunkowy `forceRerender`; `sidebarLayoutSync.js:179` odrzuca tylko starszy timestamp.
- Kolejność P0 przed P1 i zasada „migracja nie odtwarza setek operacji” są właściwe.

## Defekty blokujące

**B1 — podzadania 1.1 i 1.2: zły model tego, gdzie pending jest widoczne.**
- Potwierdzone: plakietka pending (`chat-list-item-sync-badge`) istnieje wyłącznie w HTML modala listy czatów (`chatView.js:137`). Sidebar jej nie renderuje, a `applyChatListItemVisualState` jej nie obsługuje.
- Skutek: „podłączyć dirty IDs do istniejącej aktualizacji statusów” (1.2) zgubi plakietkę w otwartym modalu albo niepotrzebnie przepatchuje sidebar.
- Potwierdzone: flagę zapisują też z pominięciem settera `pushInbox.js:281` i `chatHistoryConvergenceRun.js:226`.
- Potwierdzone: w jednym przebiegu flaga potrafi przejść true→false (`chatHistorySyncPoll.js:599` i `:614`), więc kryterium „drugi identyczny poll = zero powiadomień” nie przejdzie bez porównania netto.
- Hipoteza kosztu: `updateSidebarChatStates` robi `querySelector` po atrybucie na każde dirty ID; setki ID przy 133 tys. węzłów mogą same dać task >50 ms.
- Poprawka 1.1: jeden setter dla wszystkich trzech zapisów; dirty liczone jako różnica względem wartości sprzed batcha.
- Poprawka 1.2: pending patchuje tylko otwarty modal (dodanie/usunięcie plakietki) i selektor aktywnego czatu; przy zamkniętym modalu zero pracy DOM; duży batch w jednym przejściu, nie N × `querySelector`. Kryterium: plakietka w otwartym modalu aktualizuje się bez `renderChatList`.

**B2 — podzadanie 3.1: przyczyna wzrostu `monitoredChats` nieustalona, a wyjątek może unieważnić poprawkę.**
- Potwierdzone: `recordChatActivity` wywoływane jest tylko przy wysyłce i outpucie konkretnego czatu, więc „aktywność z 10 minut” nie tłumaczy 341+ czatów.
- Hipoteza: po `includeArchived` archiwalne czaty trafiają do `chats`, a globalny `agent-states` (189 KB wierszy nie-idle) nadaje im `_serverRunState` `waiting`/`attention`. To kwalifikuje je w `selectMonitoredChatIds` i jako priorytet w `selectHistoryHttpChatIds`, niezależnie od widoczności.
- Jeśli tak, zapisany wyjątek „żywa praca/interakcje” przepuści je z powrotem.
- Poprawka: pierwszy krok 3.1 to licznik powodów kwalifikacji (active / recent / live / busy / waiting / attention, z podziałem na `archivedAt`) na realnych danych. Polityka jawna: archiwalny czat monitorowany tylko gdy jest aktywny lub ma faktyczny run (`hasActiveAgentRun`); zaległe `attention`/`waiting` archiwum nie kwalifikuje. Kryterium na realnym zbiorze, nie tylko syntetycznym 1500/1200.

**B3 — kolejność: podzadania 7.1 i 8.2 są potrzebne wcześniej.**
- 4.3 (hydratacja) i 6.1 („porcjować hydratację”) potrzebują helpera z 7.1.
- 6.x („po P0 zmierzyć i dobrać okno”) i 7.2 („na podstawie pomiarów po P0/P1”) potrzebują instrumentacji, którą dodaje dopiero 8.2.
- Brak bramki odbioru P0; trace „przed” nie da się nagrać po wdrożeniu.
- Poprawka: przenieść 7.1 przed etap 4. Wydzielić z 8.2 nowy liść „instrumentacja + baseline” przed 1.1 oraz liść „pomiar i odbiór P0” po 3.2 (≤1 refresh na batch, 0 budów cache z pending, najdłuższy task po pollu ≤50 ms). 8.2 zostaje pomiarem końcowym.
- Cel „brak tasków >50 ms” dla otwarcia archiwum przypisać do etapu 6, bo po samym P0 pełny render archiwum nadal kosztuje 140–170 ms.

**B4 — podzadanie 5.2: sidebar nie jest w Lit, a liść jest za duży i bez decyzji o render root.**
- Potwierdzone: `sidebarView.js` (2704 linie) buduje HTML stringami i `innerHTML`, z własną sygnaturą i reuse węzłów.
- Potwierdzone: `chat.js:3680-3716`, drag, swipe, nawigacja klawiaturą i `getRenderedSidebarChatIds` sięgają po `.sidebar-chat-item[data-chat-id]` z dokumentu; style są globalne w `app.scss`.
- Potwierdzone: tylko 4 z 17 komponentów Lit używają light DOM, więc „Shadow DOM już używany” nie rozstrzyga niczego dla sidebara. Shadow root złamie te selektory i style.
- Poprawka: rozdzielić 5.2 na (a) decyzję o render root — rekomenduję light DOM — z inwentarzem konsumentów selektorów, (b) wiersz czatu jako komponent, (c) grupy/workspace z `repeat`, (d) usunięcie starej ścieżki sygnatur. Dopisać migrację testów `sidebar-signature` i `sidebar-transient-patch`, które zakładają HTML stringi.

**B5 — podzadania 4.1–4.4: nieokreślona izolacja, start offline i narzędzia testowe.**
- Potwierdzone: klient nie ma identyfikatora użytkownika; baza `cretli-sdk-chat` ma stałą nazwę. Logout/401 czyści tylko boot cache i push inbox (`api.js:103-110`, `App.js:1011`); map aktywności i historii SDK w IDB nie czyści. „Rozdzielić dane użytkowników” nie ma klucza.
- Potwierdzone: start offline jest dziś synchroniczny (`hydrateChatListFromLocalBootCache` przed siecią). Plan mówi o „ewentualnym” małym bootstrapie w localStorage, więc kryterium „offline boot działa” jest niemierzalne.
- 4.4 dodaje generację i unieważnianie po logout dopiero po kolejce (4.2) i hydratacji (4.3); między liśćmi powstaje okno, w którym zapis IDB przeżywa logout.
- Potwierdzone: brak `fake-indexeddb` i środowiska DOM w devDependencies; testy `versionchange`, zablokowanego upgrade i przerwanej transakcji nie mają harnessu.
- Poprawki:
  - 4.1: zdefiniować klucz izolacji (id konta z serwera albo twarde czyszczenie bazy przy logout/401); generację/epokę wprowadzić tutaj; wybrać harness testów (Playwright albo nowa zależność — wymaga zgody).
  - 4.3: decyzja o synchronicznym bootstrapie w localStorage (aktywny czat, workspace, pierwsze N wierszy) z kryterium pierwszego malowania.
  - 4.4: tylko transport między kartami.
  - Dopisać: przycinanie map aktywności do znanych ID, scalanie per klucz (max timestamp) zamiast nadpisywania całej mapy, flush kolejki na `pagehide`/ukryciu karty.

## Uwagi nieblokujące

- **2.1 / 2.3 / 4.2 / 4.4 — dublowanie.** Kolejka utrwalania i synchronizacja kart powstają dwa razy. Potwierdzone: dziś nie ma żadnego listenera `storage`. Poprawka: w 2.1/2.3 zdefiniować interfejs adaptera trwałości i jedną kolejkę; 4.2 podmienia backend; w 2.1 wystarczy unieważnienie przez `storage`.
- **2.2.** Dopisać, że klucz rankingu jest tożsamy z dzisiejszym `getChatUpdatedAtMs` na wierszach po sanityzacji — test równoważności kolejności.
- **3.2.** Potwierdzone: wzorzec jawnego POST już istnieje (`/api/chats/history-batch`, `listExplicitScopedChatIds`, „brak ids = 400”). Wskazać go jako bazę; dopisać, że zmiana obejmuje serwer i allowlistę widgetu (`lib/widget/widget-http.js:145-147`). `agent-states` klient woła celowo bez ids — tylko pomiar.
- **5.1.** Dopisać lokalny `forceRerender` w `toggleArchiveSection` (`sidebarView.js:2157`); liść obejmuje dziś tylko remote apply.
- **6.1.** Potwierdzone: `loadChatsFromServer` scala żądania w toku, ale kolejkuje drugie pełne pobranie po pierwszym (`chatController.js:347-357`). Zakres to polityka świeżości, nie coalescing od zera. Właścicielem odczytu archiwum z IDB powinno być 6.1; 4.1 definiuje tylko schemat.
- **6.2 / 6.3.** Zdecydować: własny wirtualizator czy `@lit-labs/virtualizer` (nowa zależność). Dopisać `aria-setsize`/`aria-posinset`, zachowanie drag i swipe na odmontowywanych wierszach. Opcjonalnie tani krok w P0: istniejący limit 40 wierszy (`capSidebarVisibleTreeChats`) zastosować do sekcji archiwum, która dziś renderuje wszystko (`sidebarView.js:1072-1081`).
- **7.1.** Fallback przez `MessageChannel` zamiast `setTimeout` (clamp 4 ms, dławienie w tle). `scheduler.yield` nie jest dostępne w Safari/iOS, więc fallback jest ścieżką główną dla PWA — testować obie. Poprawność nie może zależeć od dokończenia kontynuacji w ukrytej karcie.
- **8.1.** Dopisać rejestrację nowych testów w katalogu `scripts/review-verify.js`.

## Testy

- `node --test tests/chat-local-boot-cache.test.js` — pass (1/1)
- `node --test tests/chat-history-sync-poll.test.js` — pass (1/1)
- `node --test tests/chat-ids-query.test.js` — pass (1/1)
- `node --test tests/sidebar-layout.test.js` — pass (7/7)

Żaden nie pokrywa regresji z planu (liczniki odczytów map, liczba odświeżeń pending).

## Odstępstwa i ograniczenia

- Nie parsowałem ponownie trace 123 MB; liczby profilu przyjąłem z obu dokumentów.
- B2 (stany nie-idle archiwum) i koszt `querySelector` w B1 to hipotezy z kodu, bez pomiaru.
- Model kont sprawdziłem tylko po stronie klienta; serwerowego modelu auth nie analizowałem.
- Nie uruchamiałem UI, e2e ani `review-verify` (katalog nie ma id dla tych plików frontu).

## Pozostałe problemy, blokery, artefakty

- Do rozstrzygnięcia przez właściciela: render root sidebara, klucz izolacji danych, synchroniczny bootstrap offline, zależność do wirtualizacji i testów IDB.
- Blokery review: brak.
- Artefakty: brak. Nie edytowałem plików, Todo ani Settings; nie commitowałem; nie uruchamiałem delegacji.

TASK: review
VERDICT: FAIL

