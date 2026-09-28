# Plan naprawy synchronizacji czatu PWA

Data analizy: 2026-09-19. Zakres: analiza kodu i plan; bez zmian implementacji.

## Objawy i wniosek

Po przełączeniu aplikacji czat bywa nieaktualny mimo zakończenia pracy na serwerze. Podobnie wynik subczatu i dalsza odpowiedź rodzica stają się widoczne dopiero po ponownym otwarciu PWA.

Kod zawiera kilka niezależnych luk, które mogą wywołać takie objawy. Nie odtworzono konkretnej sesji użytkownika na telefonie, więc nie przypisujemy jej jednej udowodnionej przyczyny. Najpierw należy naprawić gwarancję zbieżności historii serwera, lokalnego magazynu i widoku. Sam restart WebSocketu nie wystarczy.

## Ustalenia z kodu

1. **Polling świadomie pomija istniejące braki.** `app_front/features/chat/chatResumePolicy.js`, `shouldSkipActiveChatHistoryPollSync`: otwarty WS poza hydratacją powoduje pominięcie dowolnej dodatniej różnicy historii. Niezależny warunek pomija różnicę do 512 rekordów również przy zamkniętym WS. Wyjątek dotyczy `hasPendingDelegation`. W `chatHistorySyncPoll.js` przy takim pominięciu kasowana jest flaga `_pendingRemoteHistory`. Aktualny test polityki częściowo utrwala to zachowanie.

2. **Kontrola braku pong może nigdy nie osiągnąć limitu.** `chatTransport.js`, `startGlobalChatPingLoop`: limit 150 s liczony jest od `_lastPingAt`, ale następny ping co 25 s nadpisuje ten czas mimo braku odpowiedzi. Przy regularnym działaniu timerów termin stale się przesuwa. Powrót do otwartego WS od razu oznacza połączenie jako zdrowe, przed odpowiedzią na ping.

3. **Odtwarzanie po ponownym połączeniu nie gwarantuje uzupełnienia istniejącego widoku.** Na urządzeniu mobilnym reconnect pomija HTTP na rzecz replay. Obsługa `replayBatch`, gdy `hasRenderedHistory()` zwraca true, jedynie przesuwa liczniki zdarzeń bez ich renderowania. `replayBatchStart` usuwa awaryjny timer, a `replayBatchEnd` może zakończyć hydratację pustą listą. Dotychczas wyrenderowana historia nie dowodzi, że zawiera nowe wiadomości. Liczniki zdarzeń pokoju i trwałej historii wymagają oddzielnego traktowania.

4. **Pobranie do magazynu jest mylone z wyświetleniem.** `sdk-chat-history-store.js`, `syncChatHistoryDeltaFromServer` aktualizuje lokalną historię oraz ACK przed powrotem do `chat.js`, `syncSdkHistoryOnResume`. Ta druga funkcja może następnie wyjść, gdy dokument jest ukryty, bez uzupełnienia widoku. Kolejne pobranie startuje już za pominiętymi na ekranie rekordami. Podobną ścieżkę trzeba sprawdzić przy błędzie renderowania. Funkcja synchronizacji przechwytuje błędy bez wyniku odróżniającego sukces od niepowodzenia; polling po jej zakończeniu może mimo to wyczyścić zaległość i zapisać czas udanej synchronizacji.

5. **Delegacje mają powiadomienia, lecz ich zabezpieczenie jest wspólne dla klientów.** `delegation-mailbox.js`, `delegation-service.js` i `chat-relation-history.js` publikują zapisane rekordy przez `sdkHistoryChanged` oraz ustawiają `hasPendingDelegation`. `getChatHistorySince` w `lib/persist/chat-history-persist.js` kasuje tę flagę przy odczycie historii, niezależnie od klienta i tego, czy pobrał wszystkie strony. Odczyt przez innego klienta może więc wyłączyć wyjątek od błędnej polityki pollingu. Samo powiadomienie WS nie gwarantuje doręczenia ani wyrenderowania.

6. **Krótki powrót może ominąć HTTP.** Obecna polityka przy otwartym WS wymaga co najmniej 8 s w tle, a wymiana takiego połączenia następuje od 60 s. Opóźnienia i cooldowny ograniczają obciążenie, ale przy powyższych lukach mogą utrwalać nieaktualny widok.

Service worker w `public/sw.js` pomija `/api/` i `/ws`. Nie ma podstaw, aby zaczynać od czyszczenia cache PWA jako naprawy synchronizacji danych.

## Kolejność wdrożenia

### 1. Odtworzenie błędów i rozdzielenie stanu danych od widoku

- Dodać deterministyczne testy z kontrolowanym czasem, WS i opóźnionym HTTP. Sprawdzać treść widoku, nie tylko liczniki.
- Zachować osobny stan pobrania danych i zastosowania ich w bieżącym widoku. Lokalny ACK nie może stanowić dowodu aktualności ekranu.
- Po powrocie uzupełniać widok także z lokalnego magazynu, jeśli rekordy pobrano w tle lub przed przerwaniem renderowania. Zapewnić deduplikację po stabilnej tożsamości rekordu i właściwą kolejność, bez utraty scrolla i wpisywanego tekstu.
- Zwracać jawny wynik synchronizacji: sukces, odroczenie, częściowe pobranie, błąd. Czyścić zaległość dopiero po potwierdzeniu odpowiedniego etapu; zachować retry po niepowodzeniu.

### 2. Zapewnić uzupełnianie każdej trwałej różnicy historii

- Usunąć bezterminowe pomijanie małych różnic i uzależnienie poprawności od samego `WebSocket.OPEN`.
- Dopuścić krótki, ograniczony czas oczekiwania na zdarzenia WS, po którym nadal istniejąca różnica wymusza pobranie HTTP.
- Po rzeczywistym powrocie z tła sprawdzać rewizję aktywnego czatu także po krótkiej nieobecności. Scalać `visibilitychange`, `pageshow` i `online` w jeden cykl.
- Jedna trwająca synchronizacja na czat; nowe sygnały podczas jej działania wymagają kolejnego sprawdzenia po zakończeniu. Ograniczenie stron pobierania nie może oznaczać końca synchronizacji, jeśli pozostaje różnica.
- Replay traktować jako przyspieszenie: po jego zakończeniu sprawdzić trwałą historię i widok. Awaryjny limit musi obejmować również brak rozpoczęcia lub zakończenia replay.

### 3. Naprawić kontrolę żywotności połączenia

- Mierzyć brak odpowiedzi od pierwszego niepotwierdzonego pingu albo osobnym terminem odpowiedzi, którego kolejne pingi nie przesuwają.
- Po powrocie wysłać kontrolny ping i uznać połączenie za zdrowe dopiero po odpowiedzi serwera. Przekroczenie ograniczonego terminu uruchamia reconnect z dotychczasowym backoffem.
- Unieważniać stare timery i callbacki po wymianie socketu. Synchronizacja HTTP powinna móc naprawić widok niezależnie od naprawy WS.

### 4. Ujednolicić aktualizacje rodzica po delegacji

- Zachować szybkie `sdkHistoryChanged`, ale oprzeć odzyskiwanie na trwałej rewizji historii i stanie danego klienta. Poprawność nie może zależeć od wspólnej flagi kasowanej odczytem.
- Zweryfikować całą ścieżkę: zakończenie dziecka → zapis wiadomości do rodzica → podjęcie pracy przez rodzica → zapis jego odpowiedzi → aktualizacja treści i statusu w UI.
- Utracone powiadomienie, odczyt z drugiego urządzenia i restart backendu muszą być nadrabiane przez ten sam mechanizm synchronizacji.
- W audycie wdrożenia sprawdzić publikację między procesami/instancjami: `sdk-history-updates.js` utrzymuje subskrybentów w pamięci procesu. Nie zakładamy tutaj, że to przyczyna zgłoszenia.

## Testy regresji i odbiór

- Powrót po 2, 10 i ponad 60 s; WS zamknięty oraz pozornie otwarty bez pong.
- Różnice 1, 10, 512 i ponad 512 rekordów; pojedyncza brakująca odpowiedź musi zostać pokazana.
- Istniejąca historia na ekranie + reconnect mobilny + nowa odpowiedź w replay; również replay bez końca lub bez początku.
- Ukrycie dokumentu po pobraniu danych, przed renderowaniem; powrót bez nowych rekordów na serwerze.
- Błąd HTTP, błąd zastosowania rekordów, ponowne wejście w tło w czasie synchronizacji, szybkie przełączanie czatów.
- Zakończenie delegacji przy rodzicu widocznym, ukrytym i odłączonym; utrata `sdkHistoryChanged`; drugi klient pobierający historię jako pierwszy.
- Historia przekraczająca limit jednej porcji synchronizacji; brak duplikatów, przestawiania rekordów i skoków scrolla.
- Test przeglądarkowy obejmujący transport, magazyn i DOM, a następnie ręczna weryfikacja na rzeczywistym PWA Android/iOS. Symulacja zdarzeń przeglądarki nie zastępuje zawieszenia aplikacji przez system.

Proponowany cel odbioru przy sprawnej sieci: aktywny czat uzupełnia widoczne braki do 5 s od powrotu; utracone powiadomienie w aktywnej aplikacji zostaje nadrobione w jednym cyklu pollingu plus czas pobrania/renderowania. Dla dużej historii widoczny postęp i dalsze pobieranie. Te wartości są celami do weryfikacji, nie gwarancją przy braku sieci.

Diagnostyka bez treści rozmów: powód synchronizacji, czas w tle, generacja socketu, wiek niepotwierdzonego pingu, rewizja serwera, stan lokalnego magazynu i widoku, wynik synchronizacji oraz przyczyna odroczenia. Pozwoli rozróżnić brak odpowiedzi agenta od braku odświeżenia UI.

## Weryfikacja wykonana podczas analizy

Przeszło 5 plików testowych: `chat-resume-policy`, `sdk-room-state`, `sdk-event-replay-guard`, `chat-history-revisions`, `chat-relation-history` (uruchomione przez `node --test`). To potwierdza stan obecnych testów, nie usuwa opisanych luk. Nie wykonano testu na urządzeniu użytkownika ani zmian kodu aplikacji.
