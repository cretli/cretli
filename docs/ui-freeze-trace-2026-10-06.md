# Cretli nadal przycina — trace 2026-10-06 15:13:20

Analiza: 2026-10-06. Zakres: analiza nowego trace, kodu i zapisanych danych;
bez zmian implementacji i bez modyfikowania historii czatów.
Poprzedni root Todo: `dcff651f-10b4-4ef0-bc41-1f705f8583dc`.

## Wynik

W tym nagraniu dominuje **odtwarzanie historii SDK i koszt ogromnego drzewa DOM**.
Wcześniejsza kaskada poll → pending → render listy → sortowanie z localStorage
nie jest już głównym kosztem. Sidebar odczuwa blokady wspólnego wątku oraz
koszt przeliczenia całego dokumentu przy zmianie jego szerokości.

Najważniejsze problemy:

1. `runViewApplyWithOrder` przy wstawianiu starszego rekordu mierzy geometrię
   przez `captureInsertScroll`. Naprzemienne zapisy DOM i odczyty geometrii
   wymuszają setki przeliczeń stylów/layoutu podczas replayu.
2. Raport delegacji z poprzedniego taska ma **800 184 B**, chociaż dwie zapisane
   odpowiedzi jego wykonawcy mają razem **4361 B**. Składanie wielu wiadomości
   i kumulatywnych snapshotów przez jeden akumulator dopisuje powtarzające się
   prefiksy. Pełny raport jest następnie renderowany jako delegacja i mailbox.
3. Replay jest uruchamiany bez oczekiwania na zakończenie; nowy replay i
   `destroy()` nie unieważniają poprzedniej pętli. Hydratacja lokalna i serwerowa
   mogą pracować równocześnie. Paczki po osiem rekordów nie ograniczają czasu
   pracy ani wielkości pojedynczej karty.

## Materiał i metoda

- Plik wejściowy jest wewnątrz katalogu o tej samej nazwie:
  `/tmp/tracew/Trace-20261006T151320.json/Trace-20261006T151320.json`.
- 422 774 zdarzenia; czas **35,790652 s** od `TracingStartedInBrowser`,
  `ts=278172339770 µs`. Renderer PID **44408**, main thread TID **66256**.
- Profil CPU `0x2`: 1159 chunks, **101 930 próbek**, **3114 węzłów**,
  suma `timeDeltas` **35,735 s**. Chunks połączone przez PID i ID profilu,
  niezależnie od ich TID; stosy odtworzone przez `parent`.
- Czasy zadań i zdarzeń layoutu są bezpośrednio z `dur`. Czasy funkcji to
  estymacja z próbek CPU. Inclusive zawiera dzieci — nie sumować go z nimi.
- Oś czasu poniżej liczona od `TracingStartedInBrowser`. Viewport z quads
  layoutu: **1920×525**, a nie mobilny viewport poprzedniego harnessu.
- Skrypty robocze i wyniki: `/tmp/cretli_trace_analysis.py`,
  `/tmp/cretli_trace_detail.py`, `/tmp/cretli_trace_replay.py` i odpowiadające
  im pliki `.txt` (ostatni skrypt wypisuje wynik na stdout).
- Bieżące pliki mają wcześniejsze niezacommitowane zmiany. Numery linii
  runtime różnią się od aktualnych; odwołania poniżej dotyczą aktualnego kodu.

## Wielkość blokad

| Metryka | Wynik |
| --- | ---: |
| Zakończone zadania głównego wątku >50 ms | **114** |
| Łączny czas tych zadań | **25 065 ms** / 35 791 ms nagrania |
| Suma części zadań ponad 50 ms | **19 365 ms** |
| Najdłuższe zakończone zadanie | **3361,5 ms** |
| `UpdateLayoutTree` | **10 658 ms**, 2214 zdarzeń |
| `Layout` | **3118 ms**, 793 zdarzenia |
| `Commit` | **7347 ms**, 322 zdarzenia |
| `PrePaint` | **2247 ms**, 664 zdarzenia |
| Maksymalne zarejestrowane opóźnienie interakcji | **2448,8 ms** |
| Maksymalna zwłoka przed obsługą tej interakcji | **1849,6 ms** |

Suma części zadań ponad 50 ms jest własną miarą dla tego okna trace,
**nie wynikiem Lighthouse TBT**. Zdarzenia różnych kategorii mogą być
zagnieżdżone; tabela nie służy do sumowania całkowitego czasu CPU.
Trace kończy się otwartym zadaniem około t=35,750 s; nie zostało ono doliczone
do 114 zakończonych long tasks.

## Dlaczego sidebar nadal reaguje wolno

| Czas od początku trace | Zdarzenie / koszt |
| --- | --- |
| 13,104 s | Task **584,7 ms**; replay **493,6 ms inclusive** |
| 14,050 s | Task **1486,3 ms**, w tym `Commit` **1363,5 ms** |
| 16,883 s | `openSidebar → applyVisibility`: task **321,9 ms**; późniejsze style **159,5 ms** i layout **76,8 ms** |
| 17,348 s | Task **1424,2 ms**, w tym `Commit` **1267,4 ms** |
| 20,235 s | Task **1217,5 ms**; replay **624,3 ms inclusive**, wymuszony layout **272,2 ms**, kolejny layout **376,4 ms** |
| 21,453 s | `togglePin → applyVisibility`: task **672,8 ms**; style **315,0 ms**, layout **196,3 ms** |
| 22,449 s | Task **3361,5 ms**, w tym `Commit` **3108,9 ms** |
| 23,962 s | Pointerdown: latency **2448,8 ms**, oczekiwanie na obsługę **1849,6 ms** |
| 29,583 s | `showPanel`: task **468,1 ms**, w tym style **455,8 ms** |

Same funkcje otwarcia sidebara mają około **18,9 ms inclusive** próbek CPU,
a funkcje przypięcia około **4,8 ms**. Duża część blokady następuje potem w
natywnej pracy przeglądarki nad dokumentem. Przykładowo layout po przypięciu
obejmuje **274 751 obiektów layoutu**, mimo `dirtyObjects=3`.

Nie ma podstaw, by utożsamiać 3,36 s z samym JS sidebara albo samym replayem:
w tym konkretnym tasku dominuje natywny `Commit`.

## Wymuszony layout podczas replayu

Łańcuch potwierdzony próbkami CPU i stosami `UpdateLayoutTree` / `Layout`:

```text
replayHistoryRecordsChunkedImpl
  → applyHistoryRecord
    → runViewApplyWithOrder
      → findInsertBeforeChild
      → captureInsertScroll
        → later.getBoundingClientRect()
      → withIsolatedRenderState → applySdkEventCore → zapisy DOM
        → isScrollableNearBottom → scrollHeight / clientHeight
```

| Ścieżka | Koszt w całym nagraniu |
| --- | ---: |
| Async continuation replayu, inclusive w dominującym węźle CPU | **12 450,5 ms** |
| `captureInsertScroll`, inclusive | **7395,0 ms** |
| `getBoundingClientRect` bezpośrednio z capture, self | **7383,9 ms** |
| `UpdateLayoutTree` ze stosu capture → replay | **6354,3 ms**, **789** zdarzeń |
| `Layout` ze stosu capture → replay | **1013,2 ms**, **338** zdarzeń |
| `UpdateLayoutTree` z `isScrollableNearBottom` w izolowanym renderze | **1238,7 ms**, **145** zdarzeń |

Osiem rekordów w paczce nie oznacza ośmiu tanich operacji. W trace paczki
`RunMicrotasks` osiągają **504,6 ms** i **627,4 ms**. Kontynuacja Promise po
`requestAnimationFrame` wykonuje się przed zakończeniem pracy nad klatką;
samo użycie rAF nie gwarantuje budżetu 50 ms.

Aktualny kod:

- `app_front/lib/sdk-rich-view.js:1536`: capture mierzy geometrię za każdym razem.
- `app_front/lib/sdk-rich-view.js:3598`: wstawianie starszego rekordu uruchamia
  capture oraz izoluje stan renderera dla pojedynczego rekordu.
- `app_front/lib/sdk-rich-view.js:963`: odczyty `scrollHeight/clientHeight`.
- `app_front/lib/sdk-rich-view.js:4528`: paczki po osiem, bez budżetu czasu.

## Skąd ogromny DOM: raport poprzedniego taska

`UpdateCounters.nodes` rośnie **33 093 → 509 961**. Listeners:
**2865 → 15 502**. Heap: około **44,8 → 113,4 MB** (max **118,1 MB**).
Licznik nodes obejmuje dokumenty renderera i także węzły odłączone oczekujące
na GC; nie jest liczbą widocznych elementów ani samodzielnym dowodem wycieku.
Niezależnym dowodem wielkiego aktywnego drzewa jest `Layout.totalObjects`,
które osiąga **276 323**.

Największe przyrosty licznika nodes przypadają na parsowanie kart:

| t | Przyrost nodes | Stos parsowania |
| --- | ---: | --- |
| 13,200 s | **48 604** | `renderDelegationCard → withIsolatedRenderState → replay` |
| 13,403 s | **53 602** | `renderMailboxCard → withIsolatedRenderState → replay` |
| 20,421 s | **99 608** | `renderDelegationCard → withIsolatedRenderState → replay` |
| 20,853 s | **99 597** | `renderMailboxCard → withIsolatedRenderState → replay` |

Todo wskazuje orchestrator chat `95deac11-2e52-4eaa-8049-e83fa0efe522`.
W jego zapisanej historii:

- seq **5319**: delegacja `958bdb4b-1dfa-4b9a-8b71-19a0135e7de9`, raport
  **782 326 znaków / 800 184 B UTF-8**, **9963** znaki nowej linii.
- seq **5320**: mailbox z identyczną treścią raportu.
- seq **5524**: kolejny wpis mailboxa z tą samą treścią.
- Child chat `6fa1cd21-6ad0-4ad2-8fba-1f316cecc02c`: dwie zapisane odpowiedzi
  assistant, razem **4258 znaków / 4361 B**. Ostatnia pełna odpowiedź znajduje
  się na końcu raportu, ale wcześniej są liczne częściowe prefiksy.
- Rozrost tekstu: **183,7×** według liczby znaków.

Nie ma payloadów HTTP/IndexedDB w trace, więc nie przypisuję każdej konkretnej
karty z tabeli do konkretnego seq. Stosy dowodzą rozrostu podczas renderowania
delegacji/mailboxa; zapisane dane osobno potwierdzają wadliwy wielki raport.

Błąd akumulatora można odtworzyć obecnym kodem bez przeglądarki:

```js
let acc = 'Komentarz. ';
for (const part of ['R', 'Ra', 'Rap', 'Raport']) {
  acc = accumulateStreamText(acc, part);
}
// wynik: 'Komentarz. RRaRapRaport'
```

`lib/sdk/sdk-plan-text.js:13` porównuje snapshot z **całym tekstem runu**.
Kiedy następna wiadomość zaczyna się inaczej niż poprzedni komentarz,
`incoming.startsWith(prev)` nigdy nie pasuje i kolejne snapshoty są dopisywane.
Wywołania: `lib/sdk/harness-plan-sync.js:64` oraz
`lib/sdk/cursor-agent-sdk-ws.js:1934`. `lib/delegation-run-bridge.js:64`
publikuje ten akumulator jako raport.

Pełna treść trafia bez ograniczenia do Markdown/DOM w
`app_front/lib/sdk-rich-view.js:3894` i `:4163`.

## Lifecycle replayu i granice okna historii

`replayHistoryRecords` (`sdk-rich-view.js:5257`) czyści stream i renderuje
pierwsze 20 rekordów, a resztę uruchamia przez
`void replayHistoryRecordsChunkedImpl(records, 20)`. Nie zwraca zakończenia
tej pracy. Kolejny replay nie unieważnia poprzedniej pętli. `destroy()`
(`:4724`) usuwa DOM i wybrane callbacki, ale nie zatrzymuje tej pętli.

W profilu są początkowe ścieżki replayu zarówno z
`hydrateSdkRichViewFromLocalCache` (próbki od **6,010 s**), jak i
`mergeServerSdkHistoryIntoRichView` (od **6,094 s**); późniejsze kontynuacje
mają wspólnego rodzica `(root)`. To dowód obecności obu ścieżek i problemu w
kontrakcie kodu, nie pomiar liczby równoległych pętli konkretnej instancji.

`chat.js:4201` i `:4232` oznaczają odtworzenie jako wykonane oraz zapisują
coverage natychmiast po uruchomieniu, zanim async replay skończy rysowanie.
Naprawa musi uwzględnić ACK/coverage i zdarzenia live.

Osobno, limit tail=80 nie jest twardym limitem renderu:
`selectTurnAlignedHistoryWindow` rozszerza go do początku tury bez ograniczenia
liczby rekordów. Na obecnych danych czatu
`f9f6294e-5491-474b-9f07-518ce257cf80` daje **508 rekordów**, co odpowiada
dużemu payloadowi history?tail=80 (**786 677 B**) w t≈6,026 s.

Kontrola aktualnej historii orchestratora daje **149 rekordów** i nie obejmuje
wielkich starych raportów. Nie można z samego pliku serwera odtworzyć zawartości
lokalnego cache podczas nagrania. Nie stwierdzono też odwróceń seq po
`sortRecordsByCreatedAt` na tych dwóch aktualnych plikach; sortowanie nie jest
tutaj wykazaną przyczyną.

## Co z wcześniejszą naprawą i siecią

W nowym profilu dwa węzły `runChatHistoryRevisionPollPass` mają łącznie około
**8,7 ms inclusive**; funkcje nadrzędne nie są do tego doliczane. Nie widać
wcześniejszej dominującej kaskady z tysiącami odczytów map localStorage.

HTTP `history-revisions` zawsze ma jawne IDs: paczki **32/32/32/32/27**,
odpowiedzi około **3,7–4,4 KB**. Brak dawnego fallbacku do wszystkich czatów.
W tym nagraniu nie ma requestu `archived=1`, więc nie jest to ponowny pomiar
otwarcia archiwum na dużych danych.

Wrażenie wolnej sieci może wynikać z blokady UI. Żądanie `agent-states` startuje
w **22,441 s**. `ResourceFinish.args.data.finishTime` wskazuje zakończenie
transferu w **22,473 s**, ale zdarzenie `ResourceFinish` na main thread pojawia
się dopiero w **26,645 s**. Analogicznie opóźnione są heartbeat i commands.
To nie jest dowód czterosekundowej pracy serwera.

## Kolejność napraw i rzeczywisty odbiór

1. **Lifecycle historii**: jedna aktywna generacja replayu na widok;
   unieważnienie po nowym replayu/destroy, kontrola po każdym yield,
   zakończenie dostępne callerom, poprawne coverage i obsługa eventów live.
2. **Render w paczkach bez przeplatania odczytów geometrii i zapisów**:
   jedna kotwica viewportu na paczkę, render poza podłączonym DOM, commit paczki,
   korekta scrolla po commitcie. Zachować kolejność, grupowanie tury i scroll
   użytkownika. Budżet czasu zamiast samego licznika ośmiu rekordów.
3. **Raporty**: akumulacja osobno dla wiadomości/itemu z rozróżnieniem
   snapshot/delta. Zachować komentarze raz. Duże istniejące raporty renderować
   jako ograniczony podgląd z otwieraniem pełnej treści na żądanie; naprawa
   generatora sama nie zmniejszy już zapisanych danych.
4. **Budżet DOM historii**: okno z ograniczeniem rozmiaru również dla jednej
   długiej tury i pojedynczej ogromnej karty. Uwzględnić zachowanie grup Activity;
   sama liczba rekordów nie gwarantuje małego drzewa.
5. **Odbiór całej aplikacji nowym trace**: hydratacja lokalna+HTTP dużego czatu,
   szybkie przełączanie czatów, sidebar open/pin, zmiana panelu, scroll/input
   podczas replayu, istniejący raport 800 KB i długa tura. Mierzyć też style,
   layout, Commit oraz opóźnienie interakcji, nie tylko synchroniczny span JS.

`docs/ui-freeze-final-acceptance-2026-10-06.md` jawnie opisuje brak nowego trace
produkcji i opiera PASS na testach/harnessach. Ten materiał potwierdza poprawę
wcześniejszej ścieżki pollingu, ale **nie potwierdza płynności całej strony**.
Nowy trace jest negatywnym dowodem dla tak rozumianego odbioru end-to-end.

## Plan zapisany w Todo

Root: `33e307a2-741d-4ec1-94d4-2aa0a94616bb` — „Naprawić replay historii
i blokady UI — trace 2026-10-06”. Szkic (`idea`), plan zapisany, wykonawcy
nieuruchomieni. **6 etapów i 14 podzadań**, kolejność sekwencyjna na obu poziomach:

| Etap | Zakres | Liczba podzadań |
| --- | --- | ---: |
| 0 | Baseline i kontrakty historii | 2 |
| 1 | Lifecycle replayu, coverage i local/HTTP/live | 3 |
| 2 | Paczki renderu, geometria i scroll | 2 |
| 3 | Akumulator, podgląd raportów i stare dane | 3 |
| 4 | Ograniczone okno DOM długiej tury i paginacja | 2 |
| 5 | Regresje, niezależne review i rzeczywisty trace odbiorczy | 2 |

Każde podzadanie ma zakres i kryteria akceptacji. Końcowy odbiór wymaga
nowego profilu Chrome całej aplikacji; sam harness nie wystarcza.
