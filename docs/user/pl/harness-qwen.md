---
title: Qwen Code
description: Skonfiguruj dostęp do Qwen Code, wybierz modele i poznaj ograniczenia.
---

# Qwen Code

Qwen Code udostępnia agenta programistycznego przez opcjonalne SDK Qwen Code, zawierające CLI. Sprawdź gotowość w **Ustawienia → Harness → Qwen**, zapisz dane dostępu i wariant endpointu, a następnie utwórz czat Qwen.

## Logowanie i modele

Utwórz klucz API w Qwen Cloud i wpisz go w ustawieniach lub przez `QWEN_API_KEY`. Wybierz rozliczenie za użycie, Token Plan albo Coding Plan zgodnie z kluczem. Klucze Token Plan i Coding Plan mogą mieć ten sam prefiks, ale nie są zamienne. Integracja nie korzysta z dawnego darmowego logowania OAuth; płatny plan nadal wymaga klucza API i pasującego endpointu.

Lista modeli jest pobierana z wybranego endpointu. Gdy pobieranie zawiedzie, Cretli używa listy zastępczej dla danego planu. Udokumentowany model domyślny to `qwen3.8-max`; rozliczenie za użycie i abonamenty mogą udostępniać różne identyfikatory. Wybierz model z listy dla swojego wariantu.

## Znane ograniczenia

Niedopasowany klucz i endpoint powodują błąd logowania, a niewłaściwy model błąd jego braku. Wyczerpanie tygodniowego limitu Token Plan wymaga oczekiwania na reset dostawcy zamiast kolejnych prób. Tryb Plan używa uprawnień planowania SDK i blokady zmian Cretli. Pytania zawsze wymagają odpowiedzi człowieka, także w trybie Agent; pojawiają się w czacie z dziesięciominutowym oczekiwaniem. Stop przerywa wykonanie; kolejne wiadomości mogą wznowić zapisaną sesję Qwen.

<!-- sources: harnesses/qwen/SETUP.md -->
