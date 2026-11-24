---
title: FAQ
description: Krótkie odpowiedzi na częste pytania o Cretli, agentów, dostęp i dane.
---

# FAQ

## Czy Cretli to usługa w chmurze?

Nie. Cretli ma otwarty kod i działa na Twoim komputerze. Strona dokumentacji jest statyczna; obszar roboczy, czaty i poświadczenia zostają na Twoim serwerze.

## Czy potrzebuję konta lub kluczy API?

Sam Cretli nie wymaga konta. Każdy silnik ma własne wymagania: niektóre używają klucza API dostawcy, inne logowania u producenta. Zobacz strony w sekcji silników.

## Jakiego agenta wybrać?

Zacznij od jednego silnika, do którego już masz dostęp. Drugi dodaj później, jeśli chcesz niezależnego przeglądu innym modelem. Zobacz [delegowanie i przegląd](delegation-review.md).

## Czy mogę używać go z telefonu?

Tak, po świadomym włączeniu dostępu LAN z HTTPS i uwierzytelnianiem. Zobacz [dostęp zdalny](remote-access.md). Domyślnie dostęp jest tylko lokalny.

## Czy bezpiecznie wystawić go do internetu?

Nie bezpośrednio. Cretli udostępnia pełny terminal. Zachowaj domyślne nasłuchiwanie lub użyj zaufanej, uwierzytelnionej i szyfrowanej granicy. Zobacz [podstawy bezpieczeństwa](security-basics.md).

## Czy Watcher sam zmienia moje repozytorium?

Watcher uruchamia ograniczone cykle pracy, ale nigdy nie zatwierdza planów i nigdy nie wypycha zmian. Automatyczna integracja jest domyślnie wyłączona. Zobacz [Watcher obszaru roboczego](workspace-watcher.md).

## Gdzie są moje dane i czy mogę je przenieść?

W folderze `data/` instalacji. Użyj narzędzi eksportu i kopii z [kopii i danych](backups-and-data.md) i nigdy nie commituj tego folderu.

## Dlaczego agent nie widzi mojego serwera MCP?

Role automatyczne widzą tylko serwery zewnętrzne z włączoną opcją **Dostępny dla agentów automatycznych**. Zobacz [MCP](mcp.md).

## Gdzie szukać pomocy?

Zacznij od [rozwiązywania problemów](troubleshooting.md), a potem zgłoś problem w repozytorium projektu bez sekretów i prywatnych ścieżek.

<!-- sources: README.md, SECURITY.md, docs/INSTALL.md, docs/mcp/SETUP.md -->
