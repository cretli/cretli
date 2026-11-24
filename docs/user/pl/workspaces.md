---
title: Obszary robocze
description: Zapisz foldery projektu, zaimportuj obszar i wybierz właściwy katalog pracy.
---

# Obszary robocze

Obszar roboczy grupuje foldery projektu, aby czaty, zadania i narzędzia działały we właściwym miejscu. W **Ustawienia → Obszar roboczy** dodaj folder projektu lub zaimportuj istniejący plik `.code-workspace` z VS Code albo Cursora. Folder musi istnieć na komputerze uruchamiającym Cretli, również wtedy, gdy łączysz się z telefonu. Na początek możesz wybrać projekt `my-app`.

## Zapisane obszary i import

Cretli przechowuje definicje obszarów we własnej bazie SQL: kolejność folderów, ich włączenie oraz folder domyślny. Do dalszej pracy z zapisanym obszarem nie potrzebujesz pliku obszaru roboczego. Import `.code-workspace` dostarcza początkową listę folderów. Późniejsze zmiany tego pliku nie aktualizują automatycznie listy w Cretli.

Użyj jawnego odświeżenia z pliku, aby zaimportować nowo dodane foldery. Odświeżenie dodaje brakujące pozycje zamiast usuwać zapisane wybory. Zapis folderów z powrotem do pliku to osobna, opcjonalna czynność. Ścieżki względne w importowanym pliku są rozwiązywane względem jego położenia.

## Przed rozpoczęciem pracy

Sprawdź wybrany obszar i folder domyślny przed utworzeniem czatu lub zadania. Czaty, zadania i delegacje są powiązane z katalogiem pracy, więc ten wybór ma znaczenie. W ustawieniach skonfigurujesz też Dokumenty obszaru: istniejący folder dokumentacji projektu działa od razu, natomiast zewnętrzny folder notatek wymaga Twojej zgody i osobnego włączenia odczytu przez agentów.

Zobacz [panele pracy](chat-and-agents.md), aby poznać narzędzia obszaru, oraz [Ustawienia](settings.md), aby znaleźć pozostałe opcje.

<!-- sources: docs/ARCHITECTURE.md, lib/persist/workspaces-store.js, lib/workspace.js, docs/docs-module.md -->
