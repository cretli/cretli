---
title: Delegowanie i niezależny przegląd
description: Jak Cretli dzieli pracę między silniki i dlaczego wynik sprawdza inny model.
---

# Delegowanie i niezależny przegląd

Cretli potrafi podzielić jedno zadanie między kilka silników agentów. Czat koordynujący sam nie pisze kodu. Uruchamia czaty potomne na innych modelach, czyta ich raporty i decyduje, co dalej. Użyj tego, gdy wynik powinien sprawdzić ktoś inny niż model, który go wytworzył.

## Pętla pracy

1. **Plan.** Powstaje plan, a tam, gdzie wymaga tego obszar roboczy, zatwierdzasz go Ty. Agenci nigdy nie zatwierdzają planów.
2. **Implementacja.** Jeden czat potomny zmienia pliki projektu i raportuje zmiany.
3. **Weryfikacja.** Cretli może uruchomić stały katalog testów na wyniku, zanim zacznie się przegląd.
4. **Przegląd.** Inny czat potomny sprawdza pracę tylko do odczytu i kończy werdyktem: PASS, FAIL albo BLOCKED.
5. **Poprawki.** Przy FAIL implementator usuwa uwagi, a pętla powtarza się, aż praca przejdzie, osiągnie limit rund albo zdecyduje człowiek.

Ta sama pętla działa w cyklach [Watchera](workspace-watcher.md), a wynik widać na [zadaniu](todos.md) jako odznakę przeglądu. Zapisuje ją wyłącznie serwer na podstawie rzeczywistych delegacji; nikt nie ustawia jej ręcznie.

## Jak wybierany jest recenzent

Prostymi słowy: Cretli wybiera spośród modeli, które włączysz jako ulubione w **Ustawieniach** dla każdej roli (plan, implementacja, przegląd, poprawki). Wybierając recenzenta:

- woli model inny niż ten, który implementował pracę, i w miarę możliwości nie powtarza poprzedniego recenzenta;
- pomija modele, które niedawno osiągnęły limit użycia albo nie uruchomiły się;
- unika bardzo szybkich, lekkich modeli w przeglądach, chyba że wskażesz je wprost;
- rozkłada pracę między silniki, żeby jeden dostawca nie był jedynym recenzentem.

Możesz też ustawić **stałą parę** recenzentów dla danego rodzaju przeglądu. Przeglądy planu mają trzy tryby współpracy: niezależny (domyślny, recenzenci się nie widzą), wymiana (jedna runda z podsumowaniami kolegów) oraz współpraca.

## Limity pod Twoją kontrolą

Czaty potomne domyślnie nie uruchamiają kolejnych delegacji; zagnieżdżanie wymaga jawnej zgody i ma limit głębokości. Dla zadania możesz ustawić budżety rund, czasu i kosztów. Zanim pozwolisz na pracę automatyczną, sprawdź, które silniki są włączone, a różnice przeczytaj sam przed integracją.

<!-- sources: docs/delegation-workflow-per-leaf.md, docs/plan-reviewer-cooperation.md, docs/todo-review-contract.md, docs/workspace-watcher.md -->
