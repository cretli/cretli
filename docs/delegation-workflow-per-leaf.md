# Stan pętli delegacji per liść

Dokument opisuje kontrakt `delegation_workflow_*` po wprowadzeniu stanu per
liść. Stan nadal zapisuje parent (serwer nie jest sekwencerem), ale klucz jest
per `(parentChatId, leafId)`, a serwer potrafi odtworzyć rundę i werdykt z
historii terminalnych jobów, gdy parent ich nie zapisze.

Model pick proposals and `pick_id` on start are documented in
[`model-pick-decisions.md`](model-pick-decisions.md). Rola joba jest zapisywana
jawnie w `pickRole` (przed normalizacją `assignment`), więc `fix` nie zlewa się
z legacy `implement`; grupowanie cykli (`delegationCycleRole`) używa tego pola,
a wiersze bez niego pozostają `implement`.

## Klucz i dopasowanie liścia

- Klucz wiersza: `parentChatId` + `leafId` (`leaf_id`/`todo_id`).
- Atrybucja joba do liścia (kolejność):
  1. pole `leafId` zapisane na rekordzie delegacji (ustawiane przy starcie z
     `leaf_id`/`todo_id` w żądaniu MCP/HTTP albo z linku parent→todo, gdy job
     nie ma innej atrybucji),
  2. jawne `leafId`/`todoId` w żądaniu startu (dla bramki przed utworzeniem
     rekordu),
  3. linia `cretli-ref todo=<id>` w `sourceText`.
- Przy starcie z planu (`sourceKind=plan`) `sourceText` bywa puste — wtedy
  `leaf_id` w żądaniu musi trafić do rekordu, inaczej historia liścia, deadline
  i budżet nie widzą joba.
- **Pusty `leafId` nie dopasowuje niczego.** Wiersz bez liścia to zachowanie
  legacy per-czat: brak inferencji z historii, brak auto-sync. Dzięki temu N
  liści nie sumuje rund w jednym wierszu.

## Runda

- `round` = liczba cykli implement/fix **od ostatniego PASS** dla tego liścia.
- Cykl otwiera terminalny `implement`/`fix`; jeżeli historii brakuje
  implementu, cykl otwiera pierwszy terminalny `review`.
- Równoległe review jednej rundy (fan-out) są grupowane: kolejne review bez
  implementu między nimi nie zwiększają rundy.
- `review` z `VERDICT: PASS` zeruje rundę; następny implement/fix startuje nowy
  cykl od 1. Auto-reset działa też na ścieżce historii (`resolve` obniża
  zapisane `round`, gdy ostatnie review to PASS).
- `resolve_delegation_workflow_row`/`inspect` syncują w górę przy nowym cyklu i
  w dół przy PASS. Werdykt jest zapisywany razem z tą zmianą, więc zagregowany
  werdykt fan-outu zapisany przez parenta nie jest nadpisywany, dopóki runda
  się nie zmienia.

## Miękki limit rund i wznowienie

- Przekroczenie `max_rounds` ustawia `stop_reason=rounds_exhausted_soft`
  (miękki stop, nie `workflow_stopped`).
- `resume_rounds: true`:
  - bez `max_rounds` — podnosi `max_rounds` o 1 powyżej `max(max_rounds, round)`
    (dokładnie jeden kolejny cykl),
  - z `max_rounds` — ustawia jawny limit.
- Bramka startu (`workflow_rounds_exhausted`) blokuje tylko wtedy, gdy
  `round >= max_rounds`; po poprawnym wznowieniu liść jest odblokowany.

## Deadline

- `deadline_at` jest budżetem czasu per liść. Po jego przekroczeniu worker
  anuluje **wyłącznie joby przypisane do tego liścia** (`cretli-ref todo=` /
  `leafId`). Wiersz bez liścia obejmuje tylko joby bez atrybucji — nigdy
  wszystkie joby parenta.
- Worker zapisuje fence `deadline_cancel_key = deadline_at`, więc przeterminowany
  wiersz nie jest anulowany ponownie w każdym ticku. Zmiana `deadline_at` zeruje
  fence.
- Start dla przeterminowanego liścia zwraca `workflow_deadline`; parent czeka na
  `slot_occupied=false`.

## Budżet kosztu/tokenów

- Pola per liść: `budget_tokens`, `budget_cost_usd`.
- Egzekwowanie: start zwraca `workflow_budget_exhausted`, gdy usage ledger
  zmierzył zużycie `>=` skonfigurowanego limitu.
- **Bezpieczeństwo przy braku pomiaru:** brak zdarzeń usage dla liścia
  (`measured=false`) nigdy nie blokuje. Podniesienie lub wyzerowanie budżetu
  wznawia liść.
- Ograniczenie: usage ledger nie ma indeksu per delegacja. Pomiar sumuje
  zdarzenia dopasowane po `delegationId` lub `chatId` jobów liścia w zakresie
  dat od najstarszego joba. Dlatego liczenie odbywa się tylko wtedy, gdy budżet
  jest ustawiony; przy dużym dzienniku może to być kosztowny skan. Gdy harness
  nie raportuje usage, budżet pozostaje nieaktywny (żadnej fałszywej blokady).

## Kody odpowiedzi bramki startu

| Kod | Znaczenie |
| --- | --- |
| `workflow_deadline` | minął `deadline_at` liścia |
| `workflow_rounds_exhausted` | `round >= max_rounds` |
| `workflow_stopped` | twardy `stop_reason` (np. `same_findings`, `blocked`) |
| `workflow_budget_exhausted` | zmierzony koszt/tokeny osiągnęły budżet liścia |
