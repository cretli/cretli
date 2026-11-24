---
title: Narzędzia MCP i klienci zewnętrzni
description: Użyj wbudowanych narzędzi Cretli, dodaj serwery MCP i podłącz klientów zewnętrznych, np. Claude Code.
---

# Narzędzia MCP i klienci zewnętrzni

MCP (Model Context Protocol) pozwala agentom wywoływać narzędzia. Cretli używa go w dwie strony: agenci w Cretli korzystają z jego własnych narzędzi i serwerów, które dodasz, a klienci spoza Cretli mogą wywoływać Cretli.

## Wbudowane narzędzia

Każdy czat na obsługiwanym silniku dostaje wbudowane narzędzia Cretli. Obejmują zadania (`todo_list`, `todo_update`), historię czatów (`chat_show`, `chat_history`), delegowanie (`delegation_start`), wbudowaną przeglądarkę (`browser_*`), porty i dokumenty obszaru roboczego. W trybie Plan odczyty działają, a zapisy wymagają trybu Agent. Przeglądarka, zadania i delegacje działają w obszarze roboczym czatu, który je wywołuje.

## Dodaj serwery MCP

W **Ustawienia → MCP** dodajesz serwer raz, zamiast edytować konfigurację każdego silnika. Obsługiwane transporty to **stdio** (polecenie i lista argumentów) oraz **Streamable HTTP** (adres URL i nagłówki). Wybierasz, które obszary robocze i silniki go widzą. Sekrety są przechowywane osobno i po zapisaniu nie są ponownie pokazywane.

Role automatyczne, takie jak czaty potomne delegacji, recenzenci i orkiestratory Watchera, dostają serwery zewnętrzne tylko po włączeniu opcji **Dostępny dla agentów automatycznych** dla danego serwera. Domyślnie jest wyłączona. Każde wywołanie narzędzia zewnętrznego trafia do **Logu dostępu** bez argumentów i wyników. Gdy serwer doda narzędzia, użyj **Odśwież narzędzia**.

## Podłącz klienta zewnętrznego

Klient zewnętrzny, np. Claude Code, Cursor lub Codex, łączy się z Cretli przez punkt `/mcp`. W **Ustawienia → MCP** zainstaluj połączenie dla folderu. Cretli zapisze wpis `cretli` w pliku `.mcp.json` tego folderu (lub odpowiednim pliku Cursor albo Codex), a token trzyma w prywatnym pliku zamiast w konfiguracji. Każdy klient ma tryb:

- **plan**: narzędzia tylko do odczytu.
- **agent**: pełny wbudowany katalog.
- **operator**: agent oraz narzędzia działające w Twoim imieniu, np. odczyt raportów delegacji, sprawdzenie lub wstrzymanie Watchera i wysłanie wiadomości do czatu.

Wybierz najniższy tryb, który wystarcza, a klienta, którego już nie potrzebujesz, odwołaj w ustawieniach. Nigdy nie wklejaj jego tokenu do czatów ani zadań.

<!-- sources: docs/mcp/SETUP.md, docs/mcp/OPERATOR-PLAYBOOK.md -->
