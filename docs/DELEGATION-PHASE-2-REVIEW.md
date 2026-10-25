# Odbiór etapu II — 2026-09-18

Pierwsza implementacja nie została przyjęta jako ukończona. Aktywnej aplikacji ani danych nie modyfikowano w reprodukcjach. Wszystkie skrypty używają izolowanego katalogu testowego.


## Odbiór nadrzędny pierwszej implementacji etapu II

Cztery zestawy delegation-phase2-runtime/dispatch/store/e2e ponownie uruchomione przez rodzica: PASS. Deklaracji npm test 286/286 nie powtarzano w tym odbiorze. Etap NIEZAKOŃCZONY: deterministyczne reprodukcje wykazały blokery danych.

- [x] P2-R1 / P0 / M7: ponowne migrateDelegationsJsonToSqlite na już przełączonym katalogu odczytuje markery backend=sqlite jako puste items i usuwa rekordy z SQLite. **Naprawione:** markery `backend=sqlite` są no-op (liczby z istniejącej bazy); checkpoint wznawia kopiowanie tabel; hash pełnej treści; migracja i rollback biorą owner lock. Test: `tests/delegation-phase2-review.test.js`.
- [x] P2-R2 / P1 / M3: luka między mkdir lockDir a zapisem owner.json. **Naprawione:** claim O_EXCL przed mkdir; brak `owner.json` nie upoważnia do kradzieży bez claimu; żywy PID + socket blokują; po śmierci holdera w luce katalog jest odzyskiwany; release sprawdza token; PID reuse i EPERM. Test w `delegation-phase2-review.test.js`.
- [x] P2-R3 / P1 / M6: updateDelegationRecord CAS poza transakcją. **Naprawione:** odczyt + expectedRevision + patch w `BEGIN IMMEDIATE` (delegacje i mailbox). Test dwóch procesów na tym samym rekordzie.
- [x] P2-R4 / P1 / M2: shutdown czeka bez limitu na kolejkę. **Naprawione:** `Promise.race` z deadline; przy timeout lock zostaje, bo późny callback może jeszcze zapisać. Test zawieszonej kolejki.
- [x] P2-R5 / M1: health mailbox bez scope / corrupt store. **Naprawione:** `collectScopedDelegationHealthRows` + `storeError`; `getDelegationRuntimeHealth` nie ukrywa uszkodzonego magazynu jako pustych liczników.
- [x] P2-R6 / M6–M7: open SQLite vs przyszła wersja. **Naprawione:** `probeSqliteSchemaVersion` (read-only) przed otwarciem do zapisu; plik bez mutacji. Test user_version=99.

M9/M11 nadal wymagają brakujących pełnych scenariuszy i klikalnego UI; M8 benchmarku skali; M10 testów ścieżek adapterów, nie tylko deklaracji capabilities. Live płatnych modeli i rollout produkcyjny nie są upoważnieniem tej delegacji. Nie oznaczać wszystkich M1–M11 jako wykonane na podstawie obecnych testów.

