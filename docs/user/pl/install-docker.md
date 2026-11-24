---
title: Instalacja przez Docker
description: Instalacja przez Docker — krótki przewodnik po bezpiecznej pracy z Cretli.
---

# Instalacja przez Docker

Cretli można uruchomić przez Docker Compose. Przed pierwszym startem ustaw CRETLI_SETUP_TOKEN. Uruchom docker compose up --build w katalogu repozytorium. Zachowaj trwałe dane przy aktualizacji kontenera.

## Przed rozpoczęciem

To wstępna polska wersja tej strony. Dokumentacja będzie rozwijana w kolejnych etapach. Zacznij od małego zadania w znanym projekcie. Upewnij się, że wybrany katalog jest właściwy i że rozumiesz zakres dostępu aplikacji. Terminal działa na komputerze serwera, także wtedy, gdy korzystasz z telefonu.

## Bezpieczna praca

Chroń hasła, klucze dostawców i dane sesji. Nie dodawaj ich do repozytorium, zrzutów ekranu ani wiadomości. Przed wykonaniem zadania przeczytaj plan, a po zakończeniu obejrzyj różnice i wyniki testów. Zachowuj kopie ważnych danych przed zmianą konfiguracji lub aktualizacją. Jeśli coś jest niejasne, zatrzymaj pracę i sprawdź komunikat w interfejsie zamiast ponawiać polecenie bez analizy.

## Następny krok

Otwórz [pierwsze kroki](getting-started.md), przejrzyj [ustawienia](settings.md) oraz [podstawy bezpieczeństwa](security-basics.md). W razie błędu skorzystaj ze strony [rozwiązywanie problemów](troubleshooting.md).

<!-- sources: docker-compose.yml, Dockerfile, scripts/docker-entrypoint.sh, lib/bind-host.js -->
