---
title: Cursor SDK
description: Skonfiguruj dostęp do Cursor SDK, wybierz modele i poznaj ograniczenia.
---

# Cursor SDK

Cursor SDK uruchamia agenta Cursor przez opcjonalny pakiet `@cursor/sdk`. Skonfiguruj **Ustawienia → Harness → Cursor SDK**, sprawdź instalację pakietu i utwórz czat z tym backendem. Terminal, pliki i pozostałe backendy Cretli pozostają dostępne, gdy brakuje opcjonalnego pakietu.

## Logowanie i modele

Wpisz klucz API Cursor w ustawieniach albo ustaw `CURSOR_API_KEY` na serwerze. Udokumentowana integracja korzysta z tego klucza; logowanie abonamentem edytora na komputerze nie zastępuje konfiguracji. Warunki usługi Cursor i limity konta obowiązują niezależnie od otwartej licencji Cretli.

Cretli pyta SDK o modele dostępne na koncie i łączy wynik z utrzymywanym katalogiem zastępczym. Jeśli pobranie listy zawiedzie, katalog zastępczy pozostaje widoczny wraz z ostrzeżeniem. Uwzględniany jest także skonfigurowany model domyślny. Włącz wybrane modele w ustawieniach i sprawdź dostęp konta, gdy widoczny model nie działa.

## Znane ograniczenia

Lista modeli natywnych podagentów Cursor obejmuje lokalne wybory Cursor; nie jest katalogiem wszystkich backendów Cretli. Do pracy na innym backendzie, takim jak Qwen lub DeepSeek, użyj delegacji Cretli. Narzędzia i sposób wykonania zależą od SDK i trybu czatu. Brak danych dostępu albo nieudana instalacja opcjonalna może uniemożliwić uruchomienie czatu mimo działania reszty aplikacji. SDK zwykle nie jest dostępne w Termux; wybierz backend obsługiwany na tym urządzeniu.

<!-- sources: docs/harnesses.md, docs/ARCHITECTURE.md, lib/routes/agent-sdk-routes.js, docs/INSTALL.md -->
