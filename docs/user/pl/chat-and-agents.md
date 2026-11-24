---
title: Panele pracy
description: Korzystaj z czatu, terminala, plików, Dokumentów i wbudowanej przeglądarki.
---

# Panele pracy

Cretli udostępnia kilka widoków tego samego projektu w przeglądarce. Wybierz [obszar roboczy](workspaces.md), a następnie panel potrzebny do kolejnego kroku. Kilka urządzeń może współdzielić sesję na żywo; polecenia nadal wykonuje komputer serwera.

## Czat i terminal

W Czacie wybierz harness i model skonfigurowany w **Ustawienia → Harness**. Tryb Plan służy analizie i przygotowaniu propozycji, a Agent wykonuje zlecone prace. Szczegółowe ograniczenia zależą od backendu. Nowe wiadomości mogą czekać w kolejce podczas pracy agenta. Ponowne połączenie odtwarza widok rozmowy; zamknięcie karty przeglądarki samo w sobie nie oznacza zatrzymania pracy serwera.

Terminal udostępnia powłokę komputera serwera. Służy do poleceń, logów i programów interaktywnych. Działa bez klucza AI. Przed wykonaniem polecenia sprawdź bieżący katalog, szczególnie po zmianie projektu.

## Pliki i Dokumenty

Panel Pliki pozwala przeglądać projekt oraz sprawdzać i edytować pliki. Wynikowe zmiany przejrzyj w Git. Panel Dokumenty przedstawia notatki projektu w Markdown. Agenci mogą proponować zmiany notatek; zatwierdzasz albo odrzucasz je w panelu. Dostęp do zewnętrznych notatek wymaga zgody, a odczyt przez agentów osobnego uprawnienia.

## Wbudowana przeglądarka

Panel Przeglądarka otwiera stronę do sprawdzania i interakcji, w tym podgląd uruchomionej aplikacji. Narzędzia przeglądarkowe agenta mogą pracować na tej samej widocznej karcie. Dostęp może wymagać karty zgody lub logowania. Wbudowana przeglądarka nie działa w Termux, a dostarczony obraz Docker wymaga dodatkowej konfiguracji przeglądarki. Aplikację, którą chcesz oglądać, trzeba wcześniej uruchomić.

![Czat na komputerze](img/chat-desktop.png)

<!-- sources: docs/ARCHITECTURE.md, docs/docs-module.md, docs/browser-runtime.md, docs/INSTALL.md -->
