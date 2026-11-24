---
title: Codex
description: Skonfiguruj dostęp do Codex, wybierz modele i poznaj ograniczenia.
---

# Codex

Codex uruchamia CLI programistyczne OpenAI na serwerze Cretli i przesyła jego pracę do czatu. Zwykle korzysta z połączenia app-server CLI; opcjonalne SDK zapewnia wariant zapasowy. W **Ustawienia → Harness → Codex** sprawdź pakiet, program i logowanie, następnie utwórz czat Codex.

## Logowanie i modele

Wybierz logowanie planem ChatGPT albo rozliczenie kluczem API. Dla ChatGPT włącz autoryzację kodem urządzenia w ustawieniach bezpieczeństwa konta i zakończ **Zaloguj przez ChatGPT**. Dla API podaj klucz w ustawieniach albo przez `CODEX_API_KEY`. Użycie planu i opłaty Platform API są oddzielne. Cretli zachowuje sesję planu oddzielnie od wykonania kluczem API.

W planie ChatGPT modele pochodzą z katalogu konta utrzymywanego przez Codex. Model nieobecny w katalogu może nie zadziałać, nawet jeśli inne konto ma dostęp. Tryb klucza API korzysta z katalogu zastępczego Cretli i konfigurowalnego modelu domyślnego. Wybieraj z aktualnej listy włączonych modeli zamiast zakładać dostępność konkretnego modelu w każdym planie.

## Znane ograniczenia

Agent ma pełny dostęp do komputera serwera i nie pyta interaktywnie o zgodę na wykonanie. Plan i domyślny przegląd używają izolacji tylko do odczytu. Sterowanie podczas tury działa w zwykłym połączeniu app-server; wariant SDK tego nie obsługuje. Stop przerywa aktywną turę, a kolejne wiadomości wznawiają zapisany wątek. Opcjonalne programy mogą być niedostępne na Androidzie, więc Termux wymaga dodatkowej konfiguracji i nie gwarantuje działania Codex.

<!-- sources: docs/codex/SETUP.md -->
