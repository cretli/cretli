# Dropdown Plan / Agent / Ask — plan wdrożenia

Status: wdrożone (2026-09-06). Dropdown Plan / Agent / Ask, tryb Ask z blokadą
mutacji przed wykonaniem narzędzia, testy jednostkowe i E2E. Poniżej zostaje
oryginalny plan dla kontekstu.

## Cel i ustalenia

Zastąpić dwuczęściowy przełącznik Plan / Agent jednym przyciskiem z aktualnym trybem i strzałką, otwierającym menu podobne do sąsiedniego „Zbuduj plan”. Menu zawiera kolejno **Plan**, **Agent**, **Ask**, z zaznaczeniem aktywnego wyboru. Zachować wysokość, typografię, odstępy i sposób pozycjonowania obecnego paska.

Przyjęta semantyka Ask: odpowiedzi na pytania, objaśnienia i analiza z możliwością odczytu kontekstu, bez edycji plików, wykonywania operacji modyfikujących ani uruchamiania implementacji. Ask jest osobnym trybem, nie aliasem Plan. Nie uruchamia zapisu planu, synchronizacji TODO ani ścieżki zatwierdzania planu. Przejście do wykonania wymaga jawnego wyboru Agent. Odpowiedź „tak” w Ask nie przełącza trybu.

Zachować dotychczasową semantykę Plan i Agent oraz domyślny tryb Agent. „Zbuduj plan” pozostaje dostępne wyłącznie w Plan, zgodnie z pozostałymi istniejącymi warunkami dostępności tej akcji. Wybór trybu nie wysyła wiadomości i nie tworzy nowego czatu.

## Rozpoznane punkty kodu

- `app_front/components/chat/cr-sdk-mode-bar.js`: `.toggle`, `handleModeClick()`, `render()`; wzorzec menu w `ensureBuildMenu()`, `renderBuildMenuItems()` i `destroyBuildMenu()`.
- `app_front/lib/dropdown.js`: istniejący kontroler Floating UI, zamykanie i nawigacja klawiaturą.
- `app_front/chat.js`: zdarzenie `cr-sdk-mode-change`, aktualizacja paska i wysyłanie `setSdkMode`.
- `lib/sdk/sdk-mode.js`: wspólny normalizator i typ; aktualnie wszystko poza `plan` zamienia na `agent`.
- `lib/sdk/sdk-ws-handshake.js`: dodatkowa binarna normalizacja wymagająca zmiany.
- `lib/persist/chats-persist.js`, `app_front/features/chat/chatController.js`: zapis i odtwarzanie trybu.
- `lib/agent-harness/harness-plan-policy.js`, `lib/sdk/sdk-plan-guard.js`, `lib/sdk/harness-plan-prompt.js`: polityki narzędzi i instrukcje Plan.
- Adaptery w `lib/{sdk,codex,opencode,openrouter,codebuddy,deepseek,qwen}/`, wspólny `lib/agent-harness/room-kernel.js` oraz `lib/mcp/`: propagacja i egzekwowanie trybu.
- `app_front/i18n/pl.js`, `app_front/i18n/en.js`: etykiety, opisy i dostępność.

Repozytorium zawiera liczne istniejące zmiany robocze, także w powyższych plikach. Przed implementacją odczytać aktualny diff i zachować cudze zmiany. Lista plików jest mapą startową, nie zamkniętym zakresem audytu.

## Kolejność wykonania

### 1. Wprowadzić kontrakt trzech trybów

Rozszerzyć wspólny typ i `normalizeSdkMode()` o `ask`, zachowując normalizację wielkości liter/białych znaków i fallback `agent` dla wartości nieznanych. Stare czaty nie wymagają migracji danych.

Przeszukać frontend i backend pod kątem `sdkMode`, `setSdkMode`, `normalizeSdkMode` oraz warunków `mode === 'plan' ? ... : ...`. Zastąpić binarną normalizację wspólną funkcją. Rozróżnić warunki „tylko Plan” od „tryb bez zmian”: nie rozszerzać wszystkich warunków Plan automatycznie na Ask.

Sprawdzić cały przepływ: wybór → stan klienta → WebSocket/API → zapis → uruchomienie → odpowiedź serwera → odtworzenie po odświeżeniu/reconnect. Uwzględnić zmianę modelu/harnessu, fork i istniejące sterowanie głosowe. Żadna ścieżka nie może po cichu zamieniać Ask na Agent.

### 2. Dodać faktyczne zachowanie Ask

Wydzielić współdzieloną klasyfikację trybów zabraniających zmian, zachowując osobne reguły planowania. Dodać instrukcję Ask: odpowiadaj i analizuj, korzystaj z dozwolonego odczytu, nie wykonuj zmian ani procedur zatwierdzania planu.

Dla każdego adaptera ustalić obsługiwane opcje na podstawie zainstalowanego SDK i aktualnego kodu. Nie przekazywać surowego `ask` do API, które nie obsługuje tej wartości. W razie potrzeby mapować tryb aplikacji na opcje adaptera z odpowiednią polityką narzędzi.

Egzekwować zakaz zmian przed wykonaniem narzędzia: zapis/edycja/usuwanie, mutujące polecenia, narzędzia MCP i delegowanie pracy mogące wykonać zmiany. Delegacja dostępna w Ask musi dziedziczyć ograniczenia; w przeciwnym razie ją wyłączyć. Instrukcja w promptcie ani przerwanie po wykonaniu mutacji nie stanowią wystarczającej blokady. Szczególnie sprawdzić Codex: obecna polityka Plan deklaruje `denyMutatingTools: false` i `abortOnMutation: false`.

Jeżeli adapter nie potrafi zapewnić tych ograniczeń, zwracać czytelny błąd braku obsługi Ask i pozostawić ostatni potwierdzony tryb; nigdy nie wykonywać żądania jako Agent. Celem wdrożenia jest działające Ask dla wszystkich aktualnie wspieranych adapterów; braki trzeba jawnie wykazać przed uznaniem zadania za kompletne.

Wykluczyć Ask z automatycznego utrwalania planu, synchronizacji TODO, „implementuj plan” i automatycznej interpretacji potwierdzeń. Zmiana dropdownu podczas aktywnego przebiegu nie może zdejmować jego ograniczeń: tryb uruchomienia pozostaje stały, a nowy wybór dotyczy następnej wiadomości lub jest odrzucany zgodnie z istniejącą polityką zajętego czatu. Odzwierciedlić tę decyzję spójnie w UI i backendzie.

### 3. Zastąpić switch dropdownem

W `cr-sdk-mode-bar.js` zastąpić `.toggle` przyciskiem „[aktualny tryb] ▾”. Wykorzystać `initDropdown` i strukturę/styl istniejącego menu „Zbuduj plan”, bez nowej biblioteki. Dodać osobny cykl życia menu trybu i usuwać element portalu oraz listenery przy odłączeniu komponentu.

Uwaga: `updated()` obecnie kończy się wcześniej przy `!showBuild`. Inicjalizacja menu trybu musi działać również dla Agent i Ask. Otwieranie jednego menu powinno zamykać drugie.

Wybór pozycji zamyka menu, aktualizuje etykietę i emituje dotychczasowe `cr-sdk-mode-change` z `{ mode: 'plan' | 'agent' | 'ask' }`. Ponowny wybór aktywnej pozycji nie powinien powodować ponownego uruchamiania połączenia. Zmiany trybu otrzymane z serwera aktualizują również zaznaczenie w menu.

Dodać `aria-haspopup`, aktualne `aria-expanded`, powiązanie z menu, `role="menuitemradio"` i `aria-checked`. Zapewnić Enter/Spację, strzałki, Escape, zamknięcie poza menu i powrót fokusu. Zweryfikować selektor opcji kontrolera dla nowych ról. Utrzymać działanie portalu poza Shadow DOM, obsługę zmiany języka i poprawną pozycję w trybie fullscreen oraz na małym ekranie.

### 4. Uzupełnić teksty

Dodać klucze PL/EN dla nazwy selektora, trzech etykiet, krótkiego opisu Ask i komunikatu blokady operacji. Widoczne nazwy pozostają Plan / Agent / Ask. Komunikat zablokowanej operacji w Ask powinien wskazywać przełączenie na Agent, bez instrukcji zatwierdzenia planu.

### 5. Zweryfikować i przekazać zmianę

Rozszerzyć istniejące testy zamiast polegać na sprawdzaniu tekstu źródłowego:

- Normalizacja: trzy wartości, stare dane, wartości błędne; handshake, zapis/odczyt i reconnect zachowują Ask.
- Zachowanie: Ask dopuszcza odczyt i blokuje mutacje przed wykonaniem; brak zapisu planu/TODO i automatycznego przejścia po „tak”. Testy obejmują granice adapterów, MCP i delegacji.
- Regresje: Plan nadal planuje i obsługuje obie akcje „Zbuduj plan”; Agent nadal wykonuje zmiany; zmiana trybu podczas przebiegu nie rozszerza jego uprawnień.
- E2E z mockami: wszystkie trzy wybory, bieżąca etykieta i zaznaczenie, klawiatura, zamykanie, odświeżenie, przełączanie czatów, fullscreen, wąski viewport i PL/EN. Zaktualizować `tests/e2e/chat-e2e-helpers.js`, które obsługują pasek trybu.

Punkty startowe testów: `tests/sdk-mode.test.js`, `tests/sdk-ws-handshake.test.js`, `tests/chats-persist-harness.test.js`, `tests/harness-plan-policy.test.js`, `tests/sdk-plan-guard.test.js`, `tests/plan-mode-enforcement.test.js`, `tests/plan-approval-reply.test.js`, `tests/voice-sdk-mode.test.js`, `tests/e2e/chat-mock.spec.js`.

Uruchomić odpowiednie testy jednostkowe, mock E2E, `npm run lint` i `npm run build:front`. Rozróżnić błędy związane ze zmianą od istniejących problemów repozytorium. Przekazać listę zmienionych plików, wyniki weryfikacji oraz zrzuty dropdownu na desktopie i telefonie.

## Kryterium ukończenia

W miejscu switcha jest jeden dropdown Plan / Agent / Ask podobny do „Zbuduj plan”. Ask zachowuje się i utrwala jako osobny tryb, umożliwia pytania i analizę, technicznie blokuje modyfikacje oraz nie uruchamia mechanizmów planowania. Dotychczasowe Plan i Agent działają bez regresji, a UI jest dostępne z klawiatury i mieści się na telefonie.
