# Modernizacja delegacji — etap IIb: odbiór po restarcie, E2E i centrum

Data: 2026-09-19.
Kontynuacja TODO `87c5390c-925d-4a29-82bc-1c847ed195d5` (etap II, status doing).
Poprawki P2-R1–R6 są bazą regresji i nie wchodzą ponownie do zakresu.
Status: etap II/IIb **zakończone** (TODO 87c5390c, e2af299f).
Etap III A/B przyjęte (`c7cb3846`). Kolejny plan luk odbioru: [docs/DELEGATION-MODERNIZATION-PHASE-3B.md](DELEGATION-MODERNIZATION-PHASE-3B.md). Kontrakt III: [docs/DELEGATION-MODERNIZATION-PHASE-3.md](DELEGATION-MODERNIZATION-PHASE-3.md).

Użytkownik potwierdził restart serwera. Live odczyt health i klikalne UI na działającej aplikacji są dozwolone jako odbiór, nie jako migracja `data/` ani rollout SQLite.

## Cel

Domknąć etap II tak, żeby dało się go oznaczyć done bez udawania: worker w żywym procesie, brakujące scenariusze serwera, centrum delegacji używalne w przeglądarce. Nie wprowadzać puli równoległych wykonawców (M12).

## Co już jest (nie powtarzać)

- Health API, lock jednego writera, boot/shutdown, tick bez czekania na adapter, CAS SQLite, migracja JSON→SQLite na kopii, retencja/summaries, fixture karty Playwright, izolowane E2E create/cancel/retry/SIGTERM.
- P2-R1–R6: remigracja, luka locka, CAS, deadline shutdown, scope health, przyszły schemat SQLite.

## Co zostało z etapu II

1. Live health aktywnego procesu nieodczytany (wcześniejszy zakaz restaru). Teraz serwer jest zrestartowany.
2. M9 częściowo: brak SIGKILL w accept, busy parent mailbox, dwóch cykli `waiting_for_input` na pełnym serwerze, reconnect UI do żywego WS (fixture karty to nie to samo).
3. M11: kod Settings → Delegacje istnieje; brak klikalnego odbioru (filtry, retry task vs delivery, klawiatura, mobile).
4. M10: coverage=unit. Live płatne modele bez jawnnego budżetu.
5. M8: brak porównania pamięci przy dużej historii.
6. SQLite: default JSON. Rollout produkcyjny świadomie poza etapem II.
7. M12: poza zakresem.

## Priorytety i zadania

P1 = zamyka etap II. P2 = nie blokuje done, jeśli ograniczenie jest zapisane. P3 = osobna decyzja.

- [ ] C1 / P1 / S — Live health po restarcie.
  Po zalogowaniu odczytać `GET /api/delegations/runtime` i Settings → Delegacje.
  Odbiór: `processAlive` i `workerRunning` są rozdzielone; `lifecycle.state` to `ready` albo jawny `degraded`; tick nie jest wiecznie `stale`; brak treści promptów w payloadzie. Zapis w TODO 87c5390c: data, `serverInstanceToken` (bez sekretów), worker on/off. Awarii nie prowokować na aktywnym `data/`.
  Zależności: restart (zrobiony).

- [ ] C2 / P1 / L — Brakująca macierz M9 na izolowanej instancji.
  Osobny port i katalog danych, prawdziwe trasy, mock/test adapter, nie aktywny serwer użytkownika.
  Odbiór: SIGKILL podczas start/accept; rodzic zajęty (mailbox nie gubi raportu); dwa cykle `waiting_for_input`; reconnect przeglądarki do tego serwera (nie tylko fixture karty); liczba runów po recovery = 1 tam, gdzie kontrakt tego wymaga.
  Kod/testy: `tests/delegation-phase2-e2e.test.js` lub nowy plik obok. Zachować istniejący Playwright karty.
  Zależności: C1 nie blokuje pisania testów.

- [ ] C3 / P1 / M — Klikalne centrum delegacji (M11).
  Filtry, retry zadania vs retry dostarczenia, Stop/ack tam gdzie karta już to ma, PL/EN, klawiatura, wąski viewport.
  Odbiór: prawdziwe trasy izolowanej instancji albo zalogowana sesja bez mutacji cudzych jobów produkcyjnych. Duplikat kliknięcia jest idempotentny. Filtr workspace/widget nie pokazuje obcego zakresu.
  Zależności: C1 dla health w UI; C2 dla spójności ze scenariuszami serwera.

- [ ] C4 / P2 / S — Skala list (M8), bez 100k na laptopie jako bramki.
  Na kopii: stronicowanie summaries przy ≥1k syntetycznych rekordów; retencja nie rusza active/uncertain. Zanotować p50 listy albo świadomie odroczyć z powodem.
  Zależności: istniejące API summaries.

- [ ] C5 / P2 / M — Ścieżki adapterów (M10) bez udawania live.
  Integration na mock/kontrolowanym SDK: review czyta fixture, mutacja odrzucona, cancel. Live DeepSeek/Qwen tylko po jawnym budżecie w tym TODO; inaczej `coverage=unit` zostaje w raporcie.
  Zależności: nie dublować osobnego TODO sesji DeepSeek.

- [ ] C6 / P2 / S — Checklist rolloutu SQLite na kopii operatorskiej.
  Dry-run, backup, migrate, restart z `CRETLI_DELEGATION_STORE=sqlite`, rollback ze scaleniem. **Nie** na aktywnym `data/`. Default pozostaje JSON, dopóki operator nie przełączy.
  Zależności: P2-R1/R6.

- [ ] C7 / P1 / S — Zamknięcie TODO etapu II.
  87c5390c → done tylko gdy C1–C3 mają dowody. C4–C6 mogą zostać „odroczone z powodem” w ciele TODO. Nie oznaczać done po samym restarcie.

- [ ] C8 / P3 / — Pula wykonawców (M12).
  Poza tym etapem. Osobny TODO dopiero po decyzji produktowej.

## Kolejność

1. C1 (odczyt live) równolegle z przygotowaniem C2.
2. C2 + C3 — bramka odbioru etapu II.
3. C4–C6 opcjonalnie w tym samym drzewie albo jako ograniczenia.
4. C7 zamyka 87c5390c.
5. C8 nie startuje.

## Zasady odbioru

Diff, testy, konkretne dowody. Nie restartować aktywnej aplikacji bez potrzeby; nie migrować aktywnego `data/`; nie odpalać płatnych modeli bez budżetu; nie commitować bez polecenia. Zachować regresje etapu I i P2-R1–R6.

Kod zapisany ≠ wdrożenie. Live health jest teraz dozwolonym odczytem, nie crash-testem produkcji.
