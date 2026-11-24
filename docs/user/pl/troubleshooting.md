---
title: Rozwiązywanie problemów
description: Rozwiązywanie problemów — krótki przewodnik po bezpiecznej pracy z Cretli.
---

# Rozwiązywanie problemów

Gdy strona nie działa, sprawdź adres, protokół HTTPS i działanie serwera. Przy problemach z agentem sprawdź konfigurację wybranego silnika i modelu. Zanim zmienisz ustawienia, zapisz treść komunikatu błędu.

## Przed rozpoczęciem

To wstępna polska wersja tej strony. Dokumentacja będzie rozwijana w kolejnych etapach. Zacznij od małego zadania w znanym projekcie. Upewnij się, że wybrany katalog jest właściwy i że rozumiesz zakres dostępu aplikacji. Terminal działa na komputerze serwera, także wtedy, gdy korzystasz z telefonu.

## Bezpieczna praca

Chroń hasła, klucze dostawców i dane sesji. Nie dodawaj ich do repozytorium, zrzutów ekranu ani wiadomości. Przed wykonaniem zadania przeczytaj plan, a po zakończeniu obejrzyj różnice i wyniki testów. Zachowuj kopie ważnych danych przed zmianą konfiguracji lub aktualizacją. Jeśli coś jest niejasne, zatrzymaj pracę i sprawdź komunikat w interfejsie zamiast ponawiać polecenie bez analizy.

## Następny krok

Otwórz [pierwsze kroki](getting-started.md), przejrzyj [ustawienia](settings.md) oraz [podstawy bezpieczeństwa](security-basics.md). W razie błędu skorzystaj ze strony [rozwiązywanie problemów](troubleshooting.md).

## Szybki przewodnik po objawach

| Objaw | Co sprawdzić |
| --- | --- |
| Przeglądarka pokazuje zerwane lub zamknięte połączenie | Sprawdź, czy proces Node nasłuchuje na porcie 3011, a potem przetestuj adres kontroli stanu z tego samego komputera. Błąd webpack to inny problem. |
| Działa na serwerze, ale nie z telefonu | Domyślnie dostęp jest tylko lokalny. Włącz LAN według opisu w [dostępie zdalnym](remote-access.md) i zezwól w zaporze. |
| Ostrzeżenie o certyfikacie | To normalne przy certyfikacie samopodpisanym. Zaakceptuj go raz na urządzeniu albo skonfiguruj zaufany HTTPS. |
| Agent nie widzi serwera MCP | Włącz **Dostępny dla agentów automatycznych** dla tego serwera; zobacz [MCP](mcp.md). |
| Kopia lub przywracanie nie startuje | Najpierw zatrzymaj serwer; zobacz [kopie i dane](backups-and-data.md). |

Nadal problem? Przeczytaj [FAQ](faq.md).

<!-- sources: docs/TROUBLESHOOTING.md, docs/browser-runtime.md, app_front/features/chat/chatServerRecovery.js, public/sw.js -->
