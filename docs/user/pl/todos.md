---
title: Zadania i plany
description: Twórz zadania, zatwierdzaj plany, ustalaj kolejność i sprawdzaj wyniki przeglądu.
---

# Zadania i plany

Utwórz zadanie dla konkretnej pracy, podając jasny cel i kryteria akceptacji. Dodaj plan opisujący zmiany oraz sposób sprawdzenia wyniku. Możesz przygotować zadanie samodzielnie albo poprosić agenta o szkic, a następnie przeczytać propozycję przed wykonaniem.

## Status i zatwierdzenie

Używaj `idea` dla wstępnego pomysłu, `ready` dla pracy gotowej do rozpoczęcia, `doing` podczas wykonania, `done` po zakończeniu oraz `deferred` dla odłożonej pracy. Zadanie czekające na zatwierdzenie planu może pokazywać wskaźnik oczekiwania mimo zapisanego statusu ready.

**Plan może zatwierdzić wyłącznie człowiek.** Agent może go napisać lub poprawić, ale nie zatwierdzić. Gdy zatwierdzenie jest wymagane, zgoda na zadaniu lub jego przodku otwiera możliwość wykonania. Przegląd planu nie daje tej zgody, a zatwierdzenie nie dowodzi poprawności implementacji.

## Kolejność i przegląd

Podziel większe zadanie na dzieci, jeśli mają odrębne wyniki. Domyślnie wykonują się kolejno: późniejsza praca czeka na zakończenie wcześniejszego dziecka. Wybieraj równoległość dla niezależnych prac. Gdy gotowe zadanie nie startuje, sprawdź opis blokady.

Odznaka przeglądu wynika z zapisanych recenzji i może wskazywać oczekiwanie, sukces, błąd lub nieaktualny wynik. Otwórz ustalenia i wyniki testów; zmiana materiału może unieważnić wcześniejszy sukces. Przegląd planu i kodu odpowiadają na różne pytania.

Praca zakończona w osobnym katalogu zadania może nadal czekać na integrację z projektem. Sam udany przegląd nie udostępnia tych plików kolejnemu zadaniu w sekwencji. Sprawdź wynik integracji razem z raportem wykonania.

![Drzewo zadań](img/todo-tree.png)

<!-- sources: docs/todo-review-contract.md, docs/todo-integration-contract.md, lib/todo-execution-prompt.js, docs/workspace-watcher.md -->
