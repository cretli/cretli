---
title: OpenRouter
description: Skonfiguruj dostęp do OpenRouter, wybierz modele i poznaj ograniczenia.
---

# OpenRouter

OpenRouter udostępnia w jednym backendzie Cretli modele wielu dostawców. Model działa zdalnie, a Cretli uruchamia narzędzia projektu na Twoim serwerze. Ten backend nie wymaga osobnego CLI dostawcy. Skonfiguruj go w **Ustawienia → Harness → OpenRouter**, następnie utwórz czat i wybierz włączony model.

## Logowanie i modele

Podaj klucz API OpenRouter w ustawieniach lub przez `OPENROUTER_API_KEY`. Obowiązuje rozliczenie API OpenRouter; zalogowanie do konsumenckiego czatu innego dostawcy nie konfiguruje tego backendu. Przechowuj klucz w ustawieniach zamiast wklejać go do rozmowy.

Cretli pobiera katalog z API modeli OpenRouter. Gdy odświeżenie zawiedzie, lista może zachować ostatni poprawny katalog z oznaczeniem nieaktualności. Bez poprawnej wcześniejszej listy używany jest katalog zastępczy. Wybierz preferowane modele w ustawieniach. Ceny i dostępność mogą się zmieniać, dlatego sprawdź wybraną pozycję przed większą pracą.

## Znane ograniczenia

Długość kontekstu, obsługiwane dane wejściowe, limity dostawcy i zachowanie narzędzi zależą od modelu. Widoczna pozycja nie gwarantuje udanego żądania na Twoim koncie. Tryby Plan i Ask blokują narzędzia zmieniające projekt. Po awarii odzyskiwany jest tekst rozmowy, a nie niedokończona sekwencja wywołań narzędzi. Przeczytaj zgłoszony błąd przed ponowieniem pracy, która mogła już zmienić pliki.

<!-- sources: docs/harnesses.md, docs/ARCHITECTURE.md, lib/providers/openrouter/openrouter-models.ts, docs/recovery-contract.md -->
