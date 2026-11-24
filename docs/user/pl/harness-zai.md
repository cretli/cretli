---
title: Z.AI
description: Skonfiguruj dostęp do Z.AI, wybierz modele i poznaj ograniczenia.
---

# Z.AI

Z.AI udostępnia osobny backend czatu GLM korzystający z oficjalnego SDK Python. W **Ustawienia → Harness → Z.AI** zainstaluj SDK dostępną akcją albo wykonaj `npm run setup:zai-sdk` na serwerze. Przed utworzeniem czatu Z.AI sprawdź dostępność SDK oraz dane dostępu.

## Logowanie i modele

Wpisz klucz w ustawieniach tego backendu albo ustaw `ZAI_SDK_API_KEY`. Wybierz pasującego dostawcę: Coding Plan lub zwykłe API Z.AI. Dostęp Coding Plan wymaga klucza, a nie interaktywnego logowania kontem konsumenckim. Te dane i wybór dostawcy są oddzielone od konfiguracji Z.AI w OpenCode. Klucz ustawiony dla OpenCode nie konfiguruje automatycznie tego backendu.

Lista modeli korzysta z utrzymywanego przez Cretli stałego katalogu GLM zamiast aktualnego zapytania o modele konta. Udokumentowane pozycje to `glm-5.3`, `glm-5.3-flash` i `glm-5.2`, z domyślnym `glm-5.3`. Włącz w ustawieniach modele, których chcesz używać.

## Znane ograniczenia

SDK wymaga obsługi Pythona na serwerze; sam zapisany klucz nie zapewnia gotowości. Jeśli dostępność nie odświeży się po instalacji, uruchom serwer ponownie. Walidacja odrzuca nieobsługiwane formaty kluczy, w tym zaczynające się od `sk-`. Stały katalog nie potwierdza dostępu do każdego modelu w wybranym planie. Po błędzie sprawdź SDK, klucz, dostawcę i dostępny limit konta przed ponowną próbą.

<!-- sources: harnesses/zai/zai.en.js, harnesses/zai/zai-api-key.js, harnesses/zai/zai-models.js, harnesses/zai/zai-routes.js, harnesses/zai/zai-sdk-client.js -->
