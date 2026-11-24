---
title: Claude Code
description: Skonfiguruj dostęp do Claude Code, wybierz modele i poznaj ograniczenia.
---

# Claude Code

Claude Code udostępnia w Cretli agenta programistycznego Anthropic przez opcjonalne Claude Agent SDK, zawierające CLI. Cretli instaluje ten pakiet osobno od zależności pozostałych backendów. W **Ustawienia → Harness → Claude** sprawdź dostępność pakietu, skonfiguruj rozliczenie i utwórz czat Claude.

## Logowanie i modele

Wybierz **Claude Code plan** i zakończ logowanie kodem, aby używać lokalnej sesji abonamentu. Możesz zamiast tego wybrać **Anthropic API key** oraz podać klucz w ustawieniach lub przez `ANTHROPIC_API_KEY`. Logowanie planem i środki API to oddzielne sposoby rozliczenia. Jeśli otrzymasz błąd braku środków API mimo zamiaru użycia abonamentu, sprawdź wybrany tryb.

Lista modeli preferuje modele zgłoszone przez działającą sesję SDK, następnie API Anthropic, gdy jest klucz. W razie potrzeby używa aliasów Claude Code, takich jak `sonnet`, `opus` i `haiku`; Cretli dodaje też nowsze identyfikatory numerowane. Udokumentowany model domyślny to `sonnet`. Dostęp konta nadal określa, które modele można uruchomić.

## Znane ograniczenia

Agent akceptuje edycje, ale nie pomija wszystkich uprawnień. Plan używa natywnego trybu planowania; Ask i przegląd tylko do odczytu blokują narzędzia zmieniające pliki przed wykonaniem. Stop przerywa pracę, a późniejsze wiadomości mogą wznowić sesję. Bedrock, Vertex, sterowanie komputerem i natywne podagenty wykraczają poza opisany zakres integracji. Nieudana instalacja opcjonalnego SDK nie blokuje innych backendów; sprawdź gotowość przed diagnozowaniem klucza.

<!-- sources: docs/claude/SETUP.md -->
