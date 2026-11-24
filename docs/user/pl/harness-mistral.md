---
title: Mistral
description: Skonfiguruj dostęp do Mistral, wybierz modele i poznaj ograniczenia.
---

# Mistral

Mistral łączy Cretli z API Mistral przez opcjonalne oficjalne SDK JavaScript. Nie wymaga CLI dostawcy. Modele działają zdalnie, a Cretli wykonuje narzędzia projektu na komputerze serwera. Skonfiguruj **Ustawienia → Harness → Mistral**, sprawdź gotowość i utwórz czat Mistral.

## Logowanie i modele

Wpisz klucz Vibe Code (`MISTRAL_VIBE_API_KEY`) albo Studio API (`MISTRAL_API_KEY`). Dostęp Vibe Code korzysta z klucza zamiast interaktywnego logowania abonamentem. Automatyczny wybór rozliczenia preferuje Vibe, gdy jest dostępne; możesz też jawnie wybrać Vibe lub Studio API. Klucz Studio korzysta z limitu API Studio, dlatego sprawdź sposób rozliczenia przed rozpoczęciem pracy.

Po skonfigurowaniu klucza Cretli pobiera aktualną listę modeli przez SDK, a w razie błędu korzysta z listy zastępczej. Udokumentowany model domyślny to `mistral-medium-latest`. Lista zastępcza obejmuje także warianty large, small, Codestral i Ministral. Wycofywane rodziny Devstral i Magistral nie są domyślnie oferowane.

## Znane ograniczenia

Plan i Ask blokują narzędzia zmieniające projekt w pętli narzędzi Cretli, zamiast zapewniać izolację systemową. Delegacje przeglądu również działają tylko do odczytu. Po awarii odzyskiwany jest tekst rozmowy, ale nie niedokończona pętla narzędzi. Starsze wpisy użycia mogą nie wskazywać źródła rozliczenia. Jeśli widzisz tylko modele zastępcze, sprawdź klucz i stan katalogu przed założeniem dostępności modelu na koncie.

<!-- sources: harnesses/mistral/SETUP.md -->
