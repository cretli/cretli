---
title: Antigravity
description: Skonfiguruj dostęp do Antigravity, wybierz modele i poznaj ograniczenia.
---

# Antigravity

Antigravity jest eksperymentalnym backendem Cretli dla CLI Google. Działa przez ACP zamiast SDK Python. Na obsługiwanym Linuksie lub macOS zainstaluj CLI przez **Ustawienia → Harness → Antigravity** albo według instrukcji dostawcy. Sprawdź, czy program jest dostępny dla konta serwera Cretli.

## Logowanie i modele

Wybierz **Zaloguj przez Google**, otwórz pokazany link i wklej kod autoryzacji z powrotem do Cretli. Dokończ logowanie i poczekaj na potwierdzenie. CLI zapisuje logowanie dla konta serwera. To uwierzytelnienie kontem Google, a nie pole klucza API; sam wskaźnik dostępności nie potwierdza logowania ani dostępu abonamentowego.

Odśwież modele i zaznacz ulubione w ustawieniach. Identyfikatory pochodzą z polecenia CLI `agy models`. Wybór `default` pozostawia decyzję programowi CLI. Jeśli pobranie listy zawiedzie, Cretli użyje default i zapisanych ulubionych.

## Znane ograniczenia

Plan i Ask wymagają zgłoszenia natywnego trybu planowania przez CLI; brak obsługi daje jawny błąd. Scout nie jest obsługiwany. Przegląd nie zapewnia certyfikowanej izolacji tylko do odczytu i wymaga ustawienia dopuszczającego takie backendy. Obrazy wymagają zgłoszonej obsługi obrazów. Pliki PDF, agenci w tle, interaktywne pozyskiwanie danych i koszty pojedynczej tury nie zostały zweryfikowane. Automatyczne odzyskiwanie także nie jest certyfikowane. Kontynuacja wymaga natywnego wczytywania sesji; CLI bez tej funkcji odrzuca kontynuację zamiast po cichu utracić kontekst.

<!-- sources: harnesses/antigravity/SETUP.md, docs/harnesses.md -->
