---
title: Xiaomi MiMo
description: Skonfiguruj dostęp do Xiaomi MiMo, wybierz modele i poznaj ograniczenia.
---

# Xiaomi MiMo

MiMo udostępnia modele Xiaomi w osobnym backendzie czatu Cretli. Wywołuje API REST zgodne z OpenAI bez dodatkowego SDK, a narzędzia projektu wykonuje Cretli. Skonfiguruj **Ustawienia → Harness → MiMo**, następnie utwórz czat MiMo i wybierz model.

## Logowanie i modele

Podaj klucz API Xiaomi MiMo z platformy MiMo w ustawieniach albo przez `MIMO_API_KEY`. Domyślny endpoint służy rozliczeniu za użycie. Dostęp Token Plan również korzysta z klucza: wpisz dokładny regionalny adres planu razem z pasującym kluczem. Nie można łączyć klucza planu z endpointem rozliczanym za użycie. Adres bazowy można też zmienić dla odpowiedniej bramy.

Cretli pobiera bieżącą listę modeli ze skonfigurowanego endpointu. Gdy jest niedostępna, lista zastępcza zawiera `mimo-v2.6-pro` i `mimo-v2.6-flash`; Pro jest udokumentowanym wyborem domyślnym. Modele towarzyszące do syntezy i rozpoznawania mowy są pomijane w tej liście czatu.

## Znane ograniczenia

Lista zastępcza nie potwierdza dostępu konta ani pozostałego limitu. Błędy logowania, limitów i obsługi modelu nadal pochodzą z wybranej usługi. Przed ponowną próbą sprawdź klucz oraz endpoint. MiMo jest też dostępne przez osobny harness OpenCode; wybierz zamierzony backend, ponieważ dedykowany harness ma własne pola ustawień. Dane dostępu przechowuj w ustawieniach, nigdy w poleceniu zadania ani udostępnianym zrzucie ekranu.

<!-- sources: harnesses/mimo/mimo-api-key.js, harnesses/mimo/mimo-models.js, harnesses/mimo/mimo-client.js, harnesses/opencode/SETUP.md -->
