# Opus 5.5 — niezależny audyt profilu Cretli

Model: `claude-opus-5-5::effort=medium`, harness Claude Code. Subchat: `a48b42c7-8afd-4122-ac4b-c169e649b16d`. Delegacja: `fd85cb31-65eb-452a-93de-a79cf2f488c4`. Audyt zakończony; kod aplikacji nie był zmieniany.

## Weryfikacja raportu przez rodzica

Potwierdzono niezależnie w surowym trace: dwa żądania archiwum w t=28,312 i 30,500 s, po 911 250 B; wcześniejsze polle z 46 IDs i odpowiedziami 6 133 B; końcowy poll bez IDs z odpowiedzią 179 166 B; wcześniejsze 184 ParseHTML ze stosu pending w oknie 33,996 ms. Potwierdzono też próg 2 048 znaków w `app_front/lib/chatIdsQuery.js` i semantykę „wszystkie dostępne czaty” po pominięciu IDs w routes.

Uwagi do interpretacji poniższego raportu:

- Około 1 300 czatów i około 44 s to ekstrapolacje rozmiaru odpowiedzi/tempa iteracji, nie liczby odczytane z payloadu. Nie stanowią górnej granicy blokady. Potwierdzone: co najmniej 341 odświeżeń i 11,2 s blokady.
- Sama widoczność w sidebarze nie kwalifikuje do pollingu: `selectHistoryHttpChatIds` przecina widoczne ID z `selectMonitoredChatIds`. Ten drugi wymaga aktywnego czatu, aktywności w ostatnich 10 minutach lub stanów live/busy/waiting/attention. Kod nie wyklucza archiwalnych czatów. Politykę należy poprawić, zachowując wyjątki dla aktywnego czatu i żywej pracy, oraz sprawdzić, dlaczego tak wiele czatów kwalifikuje się do monitorowania.
- `sortChatsByFavoriteThenDate` w bieżącym kodzie porównuje favorites i datę utworzenia. Nie używa bezpośrednio map aktywności; zalecenie snapshotów dotyczy boot-cache i selekcji monitoringu/socketów.
- Dwa żądania archiwum są dowodem ponownego pobrania, ale nie dowodem ich równoległości. Coalescing żądań w toku i polityka odświeżania wymagają osobnych regresji.
- Cele czasów/DOM/transferu w raporcie są propozycjami do kalibracji na porównywalnych danych i urządzeniu; nie są wynikiem wdrożonej poprawki.

Przyjęte uzupełnienia planu zapisano w `docs/ui-freeze-trace-2026-10-05.md`. Poniżej pełny raport Opusa w oryginalnej postaci.

---

# Audyt trace zawieszenia UI Cretli (2026-10-05) — raport niezależny

## Wynik

Diagnoza rodzica w `docs/ui-freeze-trace-2026-10-05.md` jest poprawna co do dominującej przyczyny i liczb. Samodzielne parsowanie trace dało te same wartości (różnice ≤1 ms). Plan jest trafny, ale ma braki opisane niżej: nie nazywa wyzwalacza (otwarcie archiwum), nie ogranicza zbioru pollowanych czatów u źródła i nie wykorzystuje porównania „przed/po progu 300”, które jest w tym samym nagraniu.

Zawieszenie to skończona, bardzo kosztowna pętla, nie pętla nieskończona. Trace urywa się w jej trakcie, więc 11,2 s to dolna granica.

## Metoda

- Trace parsowany samodzielnie przez `jq` (Python został zablokowany przez hook read-only); dokument rodzica przeczytany dopiero po własnej analizie.
- 397 580 zdarzeń, zakres 48,455 s od `TracingStartedInBrowser` (ts=219601559746). Renderer PID 44408, wątek główny TID 66256.
- Profil CPU: jeden profil `0x1`. Zdarzenie `Profile` jest na TID 66256, a 1 563 `ProfileChunk` na TID 55844. Razem 130 943 próbki, 4 544 węzły, suma `timeDeltas` 46,33 s.
- Czasy funkcji: skumulowane `timeDeltas` od `startTime` profilu, self i inclusive po łańcuchu `parent`.

## Dowody z trace

### 1. Końcowa blokada

- Jedyne otwarte `B` bez `E` na wątku głównym: `RunTask` w t=37 247,032 ms i `RunMicrotasks` w t=37 247,035 ms. Do końca nagrania (48 455 ms) trwają ≥11,208 s. Pozostałe otwarte `B` to artefakty końca nagrania lub inne procesy.
- Bezpośrednio przed blokadą kończą się `GET /api/chats/agent-states` (189 165 B, 37 233,6 ms) i `GET /api/chats/history-revisions` bez `ids` (179 166 B, 37 247,0 ms). Blokada to kontynuacja `await getChatHistoryRevisions` w jednym mikrozadaniu.
- Wewnątrz otwartego zadania nie ma Layout, stylu ani paint. Jest 1 364 × `ParseHTML` (łącznie 53 ms), 112 × `MinorGC` (36 ms) i 1 476 × `UpdateCounters`. Ponad 99% to czysty JS.
- Profil CPU w oknie blokady (11 201 ms próbek), czasy inclusive:

| Funkcja | Czas |
| --- | ---: |
| `runChatHistoryRevisionPoll → setChatPendingRemoteHistory → onPendingHistoryChange → renderChatList` | 11 134 ms (99,4%) |
| `persistChatListBootCache → writeChatLocalBootCache` | 10 505 ms (93,8%) |
| `selectChatsForBootCache` | 10 414 ms |
| komparator sortowania → `getChatUpdatedAtMs` | 9 965 ms |
| `getChatActivityAt` | 8 120 ms |
| `readObjectMap` (inclusive / self) | 7 853 / 6 764 ms |
| `parseIsoMs` (self) | 1 660 ms |
| `localStorage.getItem` (self) | 564 ms |
| `chatView.renderChatList` (selektor czatu i modeli) | 624 ms (5,6%) |
| w tym `refreshModelSelectLabels` | 406 ms |
| w tym `updateChatBarSelect` | 217 ms |

- `ParseHTML` jest tylko znacznikiem pętli, nie jej kosztem. Stosy to 682 × `renderModelSelectOptions:562` i 682 × `_renderPanelItems:234`, wszystkie przez `setChatPendingRemoteHistory:158 ← runChatHistoryRevisionPoll:602`. Po 4 parsowania na render daje to 341 wywołań `renderChatList`.
- Tempo jest stałe: 120–124 `ParseHTML` na sekundę przez całe okno, czyli około 31 renderów/s i 32,7 ms na render. Koszt iteracji nie rośnie, więc praca jest liniowa względem liczby czatów ze zmienioną flagą.

### 2. Wyzwalacz (brak w dokumencie rodzica)

- W t=28 312 ms i ponownie w t=30 499 ms użytkownik klika sekcję archiwum: `onSidebarBodyClick → toggleArchiveSection → requestLoadArchivedChats → GET /api/chats?includeArchived=1`. Odpowiedź ma 911 250 B, wobec 107 900 B dla zwykłego `/api/chats`.
- Liczba węzłów DOM rośnie z 14 022 do 115 447–133 231.
- Poll chodzi co 15 s (`POLL_INTERVAL_MS`). Pulle w 8,72 s i 22,22 s wysyłają 46 `ids` (URL 1 846 znaków, odpowiedź 6 133 B). Poll w 37,24 s jest pierwszym po otwarciu archiwum i idzie bez `ids`, bo lista przekracza `MAX_CHAT_IDS_QUERY_LENGTH = 2048` (`lib/chatIdsQuery.js:51`). Serwer zwraca wtedy wszystko.
- Zbiór monitorowany puchnie, bo `selectHistoryHttpChatIds` dopuszcza czaty widoczne w sidebarze (`getRenderedSidebarChatIds()`), a po rozwinięciu archiwum wyrenderowane są wszystkie zarchiwizowane wiersze.

### 3. Porównanie przed/po progu 300 w tym samym trace (brak w dokumencie)

- Pierwszy poll po reloadzie (t=8 734–8 768 ms) wykonuje tę samą pętlę: 180 `ParseHTML` z linii runtime 602 (45 renderów, pending→true) i 4 z linii 589 (1 render, →false).
- Całość trwa około 34 ms, czyli około 0,75 ms na render, bo przy ≤300 czatach `selectChatsForBootCache` wraca przed sortowaniem (`chatLocalBootCache.js:231`).
- Po przekroczeniu 300 ten sam render kosztuje 32,7 ms, czyli około 44 razy więcej. Wada „render na każdy czat” istniała cały czas; próg 300 zamienił ją w blokadę.
- Dodatkowa obserwacja: 45 z 46 monitorowanych czatów dostaje `pending=true` przy zimnym starcie. Warto sprawdzić, czy to nie fałszywe plakietki (hipoteza: `localAck`/`viewAppliedSeq` równe 0 przed hydratacją).

### 4. Wcześniejsze przycięcia

- Długie zadania (>50 ms) przed blokadą: 15 sztuk, łącznie 1 941 ms, TBT 1 191 ms. Jedenaście z nich przypada na 28,34–31,23 s i trwa 58–169 ms.
- Profil okna 28,3–31,3 s: `socket.onmessage → onSidebarLayout → applyRemoteSidebarLayout → App.apply → forceRerender` zajmuje 842 ms; cały `sidebarView.render` 1 093 ms; `get scrollTop` 410 ms self (wymuszony layout); `toggleArchiveSection` 239 ms.
- Ten sam sort boot-cache pojawia się już tutaj: `persistChatListBootCache` 96 ms.
- W tym oknie są 4 × `PATCH /api/sidebar-layout` (28 467, 29 671, 30 823, 31 371 ms; dwa trwały 763 i 525 ms), a zadania `onmessage` następują tuż po nich. To korelacja wskazująca na echo własnych zmian; treści ramek WS nie ma w trace.

### 5. Liczniki

- Heap 31–80 MB, piłokształtny w blokadzie (Scavenge), bez trendu wzrostowego. Nie ma `MajorGC` w blokadzie.
- W blokadzie przybywa 5 105 węzłów (115 624 → 120 729) i 340 listenerów (1 783 → 2 123), czyli około 15 węzłów i dokładnie około 1 listener na render.

## Dowody a hipotezy

**Dowody (trace i kod):**
- Łańcuch wywołań i udziały czasu z sekcji 1.
- Pętla `for (const chat of monitoredChats)` (`chatHistorySyncPoll.js:579`) jest skończona. `setChatPendingRemoteHistory` działa tylko przy zmianie flagi (linia 152), a wszystkie 341 wywołań pochodzi z jednego miejsca: runtime 602, czyli workspace 599 (`setChatPendingRemoteHistory(chat, true)`). Górna granica to jeden render na monitorowany czat z tego miejsca.
- Przesunięcie numerów linii runtime → workspace wynosi stale +3: `setChatPendingRemoteHistory` 158→155, `getChatHistoryRevisions` 576(0-based)→574, 602→599. W `chat.js` przesunięcie jest większe, bo plik ma niezacommitowane zmiany: `renderChatList` 3845→3900, `onPendingHistoryChange` 2993→3048.
- Kod w workspace nadal zawiera wadę: `chat.js:3048–3050`, `chat.js:3900–3904`, `chatLocalBootCache.js:231–236`, `chatStore.js:11–21` i `46–53`.

**Hipotezy:**
- Całkowity czas blokady. M ≥ 341 to dowód. Jeśli serwer zwrócił rewizje wszystkich czatów, to 179 166 B przy około 133 B na wpis daje około 1 340 czatów, czyli do około 44 s. Realnie 11–44 s.
- Echo własnych PATCH jako źródło ramek `sidebarLayout`.
- Jeden listener na render jako wyciek w `cr-searchable-select` / `refreshOptions`. Może to być też śmieć nieodebrany z powodu braku major GC w jednym tasku.
- Jeśli stan rozwinięcia archiwum jest utrwalany i ładowany przy starcie, blokada wystąpi przy każdym zimnym starcie (poll rusza 1,5 s po boocie). Nie sprawdzałem tego.
- Rozmiar 189 KB dla `agent-states` przy opisie „idle omitted” jest podejrzany.

## Ocena dokumentu rodzica

**Potwierdzone:**
- Wszystkie liczby tabeli (11 201 / 11 135 / 10 506 / 10 415 / 9 966 / 6 765 / 1 660 / 406 ms).
- 1 364 `ParseHTML` = 341 odświeżeń; otwarte `RunTask`/`RunMicrotasks` od 37,247 s; łączenie profilu przez PID i `0x1`.
- Wniosek o skończonej pętli i o tym, że samo przeniesienie do Promise nic nie da.
- Lokalizacje w kodzie: `sidebarLayoutSync.js:180`, `App.js:550–555`, `sidebarView.js:2676`, `chatLocalBootCache.js:231/233/375` (w workspace 373–384).
- Trafne uwagi o `undefined → false` i o zbyt późnym fingerprincie.

**Błędy i nieścisłości:**
1. „Listenerów 9 660” pochodzi z poprzedniego dokumentu, sprzed reloadu w t≈7,7 s. Po reloadzie maksimum to 4 041 (chwilowo w 28,47 s), a w blokadzie 1 783–2 123. Nie należy łączyć tej liczby z zawieszeniem. 133 231 węzłów jest poprawne i pochodzi z otwartego archiwum.
2. „Pięć `socket.onmessage` po 139–163 ms” to niepełny obraz. W oknie jest 11 długich zadań, w tym kliknięcie archiwum (100 ms) i zadanie po `GET includeArchived` (164 ms).
3. Dane w tabeli „Dodatkowe potwierdzenie mechanizmu” (2 856 / 17 664 / 32 368 odczytów) nie zostały przeze mnie odtworzone, bo hook blokuje dowolne skrypty. Mechanizm jest zgodny z kodem; konkretne liczby pozostają niezweryfikowane.

**Braki:**
1. Nie nazwano wyzwalacza (otwarcie archiwum, dwa pobrania po 911 KB) ani tego, że wyrenderowane wiersze archiwum trafiają do pollingu.
2. Nie wykorzystano porównania 0,75 ms vs 32,7 ms na render z tego samego trace.
3. Plan nie ogranicza zbioru u źródła: zarchiwizowane czaty nie powinny być pollowane ani dostawać plakietki pending.
4. Brak punktu o fallbacku „bez `ids`”: po przekroczeniu 2 048 znaków klient co 15 s pobiera około 368 KB JSON (189 + 179 KB).
5. Brak estymaty pełnego czasu pętli i liczbowych kryteriów odbioru.
6. Brak punktu o przyroście jednego listenera na render.
7. Wirtualizacja lub stronicowanie archiwum jest odłożone „na później”. Przy 115–133 tys. węzłów każdy pełny render sidebara kosztuje 140–170 ms, więc powinno to być P1.
8. Podwójne `GET /api/chats?includeArchived=1` w odstępie 2,2 s nie jest wspomniane.

## Plan naprawy według priorytetu

**P0-a. Jeden refresh na poll.** Zbierać ID w `setChatPendingRemoteHistory`, robić jeden flush przez `scheduleChatListStateRefresh(dirtyIds)`, tak jak już robi `onAgentStatesChange`. Flush także przed `await syncSdkHistoryOnResume` i w `pullBackgroundHistoryQueue`. Znormalizować `undefined`/`false`. Efekt w tym scenariuszu: z 341+ renderów do 1.

**P0-b. Boot-cache poza `renderChatList`.** Wywoływać `persistChatListBootCache` tylko po `loadChatsFromServer` i zmianie aktywnego czatu lub workspace, z debounce albo `requestIdleCallback`. W `selectChatsForBootCache` czytać obie mapy raz i liczyć klucz raz na wiersz. Dać `getChatActivityAt` wariant ze snapshotem map; te same odczyty siedzą w `selectMonitoredChatIds`, `selectBackgroundWsChatIds` i `sortChatsByFavoriteThenDate` (118 ms w oknie 28–31 s).

**P0-c. Wyłączyć zarchiwizowane czaty z pollingu** rewizji i z plakietki pending. Dopuszczać tylko czat aktywny lub z żywym agentem. Ograniczyć „visible” do faktycznie widocznych w viewport albo do twardego limitu.

**P1-a. `sidebarLayout`:** ignorować echo i payloady równoważne, nie używać `forceRerender` w `App.apply`, grupować odczyty `scrollTop` przed mutacjami.

**P1-b. Archiwum:** stronicowanie lub wirtualizacja wierszy; deduplikacja równoległych `requestLoadArchivedChats`.

**P1-c. Fallback bez `ids`:** dzielić na partie albo użyć POST. Sprawdzić rozmiar `agent-states`.

**P2.** `refreshModelSelectLabels` tylko przy zmianie katalogu lub aktywnego czatu (406 ms na 341 renderów). Zbadać przyrost listenerów w `cr-searchable-select`. Zweryfikować 45/46 pending przy zimnym starcie.

## Testy regresji

- **Poll:** 1 500 czatów (w tym 1 200 zarchiwizowanych) z `headSeq > ack`. Oczekiwane: `onPendingHistoryChange` lub flush ≤1 raz na przebieg, 0 wywołań `persistChatListBootCache`, 0 wywołań `refreshModelSelectLabels`. Drugi identyczny poll: 0 refreshy. Zarchiwizowane czaty nie trafiają do `monitoredChats`.
- **Boot-cache dla 300 / 301 / 1 000 / 1 500 czatów:** liczba `getItem` na budowę stała (≤4 łącznie z aliasami) i niezależna od N. Cap 300, aktywny i `watcherPinned` zachowane, kolejność identyczna z obecną.
- **`getChatActivityAt` ze snapshotem:** ten sam wynik co bez snapshotu; zapis `recordChatActivity` widoczny w następnej operacji.
- **Layout:** identyczna wiadomość `sidebarLayout` (i echo własnego PATCH) nie wywołuje `render`; realna zmiana częściowa wywołuje jeden render.
- **Archiwum:** dwa szybkie kliknięcia dają jedno żądanie `includeArchived`.
- **E2E (Playwright, dane ≥1 300 czatów):** otwarcie archiwum, odczekanie ≥16 s na poll, wpisywanie w polu wiadomości.

## Kryteria pomiaru przed/po

Ten sam scenariusz: reload → otwarcie archiwum → 20 s czekania.

| Metryka | Przed (ten trace) | Cel |
| --- | ---: | ---: |
| Najdłuższy task po pollu | ≥11 208 ms (niedokończony) | ≤50 ms |
| Wywołania `renderChatList` na poll | ≥341 | ≤1 |
| `writeChatLocalBootCache` w oknie pollu | 10 505 ms | 0 ms w pollu; ≤5 ms na budowę przy 1 500 czatach |
| `readObjectMap` na budowę cache | tysiące | 2 |
| `ParseHTML` na poll | ≥1 364 | ≤4 |
| Zadania >50 ms w 28–31 s (archiwum) | 11, maks. 169 ms | ≤2, maks. ≤100 ms |
| `onSidebarLayout` inclusive | 842 ms | ≤50 ms |
| Węzły DOM po otwarciu archiwum | 115–133 tys. | ≤30 tys. (po P1-b) |
| Transfer pollu na 15 s | około 368 KB JSON | ≤20 KB |
| Przyrost listenerów na `renderChatList` | +1 | 0 |

## Testy uruchomione

- `node --test tests/chat-local-boot-cache.test.js` — pass (1/1).
- `node --test tests/chat-history-sync-poll.test.js` — pass (1/1).
- Żaden z nich nie pokrywa regresji: w teście pollu nie ma asercji na `onPendingHistoryChange`, w teście boot-cache nie ma licznika `getItem`.

## Odstępstwa, problemy, blokery, artefakty

- **Odstępstwo:** analiza w `jq` zamiast Pythona (hook). Nie odtworzyłem syntetycznego eksperymentu rodzica w Node.
- **Pozostałe problemy:** dokładna liczba monitorowanych czatów i pełny czas blokady są nieznane, bo trace jest ucięty i nie zawiera treści odpowiedzi. Treść ramek WS jest nieznana.
- **Blokery:** brak.
- **Artefakty:** brak. Nie edytowałem żadnych plików, nie commitowałem i nie uruchamiałem delegacji.

TASK: audit
VERDICT: PASS

