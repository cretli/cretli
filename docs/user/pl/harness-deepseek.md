---
title: DeepSeek
description: Skonfiguruj dostęp do DeepSeek, wybierz modele i poznaj ograniczenia.
---

# DeepSeek

DeepSeek korzysta z oficjalnego SDK DeepSeek Harness i lokalnego programu wykonującego pracę w projekcie z czatu Cretli. Oba pakiety są opcjonalnymi zależnościami Cretli. Sprawdź ich instalację, skonfiguruj **Ustawienia → Harness → DeepSeek** i utwórz czat DeepSeek.

## Logowanie i modele

Użyj klucza API DeepSeek Platform, wpisanego w ustawieniach albo przez `DEEPSEEK_API_KEY`. To dostęp API, a nie logowanie abonamentem konsumenckiego czatu. Gotowość wymaga zarówno klucza, jak i programu wykonawczego.

Po podaniu danych Cretli pobiera modele z aktualnego endpointu DeepSeek. Udokumentowany model domyślny to `deepseek-flash`; lista zastępcza obejmuje również `deepseek-v4-pro`. Lista włączonych modeli normalizuje starsze identyfikatory Flash. Wybieraj z obecnej listy ustawień zamiast podawać model innego dostawcy. Własne podagenty DeepSeek przyjmują oficjalne modele DeepSeek; do pracy na innym backendzie służy delegacja Cretli.

## Znane ograniczenia

Harness jest wersją rozwojową i aktualizacje mogą łamać zgodność. Pierwsze uruchomienie może potrwać kilkadziesiąt sekund. Tryb Plan przekazuje instrukcję odczytu zamiast natywnego trybu uprawnień planowania. Zatrzymanie pracy zamyka proces wykonawczy; po zatrzymaniu lub restarcie serwera kolejna wiadomość rozpoczyna nową sesję dostawcy. Flash obsługuje obrazy, a udokumentowany model Pro tylko tekst. Przed wznowieniem sprawdź błędy i zachowany kontekst rozmowy.

<!-- sources: harnesses/deepseek/SETUP.md -->
