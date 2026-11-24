---
title: Watcher obszaru roboczego
description: Wybierz tryb Watchera i poznaj wykonanie, integrację oraz restart.
---

# Watcher obszaru roboczego

Watcher sprawdza gotową pracę w obszarze roboczym i koordynuje ograniczone cykle wykonania. Skonfiguruj go w **Ustawienia → Watcher obszaru roboczego** po wybraniu backendów, modeli i zasad dla projektu.

## Wybierz tryb

- **off**: harmonogram nie wykonuje działań i nie uruchamia pracy.
- **observe**: zapisuje decyzje i może powiadamiać o oczekującej pracy; nie uruchamia agentów wykonujących zadania.
- **autopilot**: może rozpoczynać dostępną pracę w granicach budżetów, równoległości, godzin ciszy i wymaganych zgód.

Opcjonalne funkcje Scout i obsługa zgłoszeń mają osobne ustawienia. Sprawdź je oddzielnie, ustalając dopuszczalną aktywność w tle.

## Przebieg cyklu

Watcher sprawdza zadania, aktywne czaty i wolne miejsca, rezerwuje zadanie oraz uruchamia czat koordynujący jeden cykl. Ten czat organizuje implementację, niezależny przegląd i potrzebne poprawki. Raportuje wynik przed zwolnieniem miejsca. Zatwierdzenie planu przez człowieka nadal obowiązuje tam, gdzie wymaga go polityka obszaru: **Watcher nigdy nie zatwierdza planów**.

Gdy praca czeka, otwórz raport zadania i widok decyzji Watchera. Przyczyną może być brak danych logowania, wcześniejsze zadanie w sekwencji, budżet albo decyzja człowieka. Po restarcie serwera Cretli sprawdza przerwane cykle zamiast bezwarunkowo uruchamiać duplikaty.

## Integracja i restart

Automatyczna integracja jest **domyślnie wyłączona**. Po jawnym włączeniu dla obszaru niezależnie zweryfikowana praca może zostać przetestowana i zintegrowana jako lokalny commit. Konflikty lub nieudane kontrole zatrzymują integrację; niezwiązane lokalne zmiany są zachowane. Bez włączenia tej opcji zakończona praca czeka na działanie integracji.

Po integracji Cretli może skoordynować restart serwera dla zmian kodu wykonywanego, czekając na zakończenie aktywnych cykli. Gdy zmieniły się interfejs i backend, najpierw buduje interfejs; błąd budowania pomija restart. Sprawdź błędy przed wznowieniem automatyzacji. **Watcher nigdy nie wysyła zmian przez push** do zdalnego repozytorium.

![Panel Watchera](img/watcher-panel.png)

<!-- sources: docs/workspace-watcher.md, docs/todo-integration-contract.md -->
