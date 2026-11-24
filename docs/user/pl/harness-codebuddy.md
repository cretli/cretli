---
title: CodeBuddy
description: Skonfiguruj dostęp do CodeBuddy, wybierz modele i poznaj ograniczenia.
---

# CodeBuddy

CodeBuddy łączy Cretli z agentem programistycznym Tencent przez opcjonalne Agent SDK i program CodeBuddy CLI. Zainstaluj oba składniki albo wskaż istniejący program w ustawieniach. W **Ustawienia → Harness → CodeBuddy** sprawdź pakiet, CLI i dane dostępu przed utworzeniem czatu.

## Logowanie i modele

Utwórz klucz API CodeBuddy i zapisz go w ustawieniach albo przez `CODEBUDDY_API_KEY`. Integracja używa klucza API zamiast logowania abonamentem. Wydania China, iOA i dedykowane wymagają konfiguracji środowiska serwera; wybór takiego wydania nie jest dostępny w ustawieniach.

Lista modeli sprawdza aktualny katalog konta i zachowuje jawne identyfikatory Tencent Hunyuan Hy. Aliasy mogące wskazać modele innych dostawców są pomijane. Udokumentowany wybór domyślny to `hy4-preview-f`; nieudane sprawdzenie konta powoduje użycie listy zastępczej Hy3 i Hy4 Preview. Do modeli innych dostawców używaj ich dedykowanych backendów.

## Znane ograniczenia

Dostępność modeli zależy od konta, więc identyfikator zastępczy nadal może zostać odrzucony. Odrzucony model nie jest automatycznie wybierany przez 24 godziny; odblokujesz go w karcie stanu backendu. Tryb Agent pomija natywne pytania o uprawnienia, natomiast Plan używa uprawnień planowania. Wczytywane są instrukcje projektu, ale nie ustawienia użytkownika i lokalne CodeBuddy. Kolejne wiadomości korzystają z jednego działającego procesu CLI; nowy proces nie musi zachować całego poprzedniego stanu wykonania.

<!-- sources: harnesses/codebuddy/SETUP.md -->
