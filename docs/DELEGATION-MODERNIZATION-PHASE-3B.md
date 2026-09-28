# Modernizacja delegacji — etap IIIb: luki odbioru III i wdrożenie

Data: 2026-09-19.
Kontynuacja TODO `c7cb3846` (etap III, **A/B przyjęte**; C z ograniczeniami).
Kontrakt III pozostaje: [DELEGATION-MODERNIZATION-PHASE-3.md](DELEGATION-MODERNIZATION-PHASE-3.md).
Ten dokument **nie** powtarza D1–D9. Nie otwiera puli wykonawców (D10).

Status: **ready — plan do zlecenia implementacji.** TODO: `3ee4bca9-6646-460d-8084-0161fa9e11ab`.

## Werdykt rodzica po III

Izolowane testy A/B zaliczone. Nie jest to odbiór „wszystkie bramki III ukończone”:

1. **Kod ≠ proces.** `:3011` nie był restartowany w rundzie III. Historyczny token IIb nie dowodzi kodu III w pamięci. MCP `attempt_id` / CONFLICT `still_active` na żywym serwerze są niepotwierdzone.
2. **D5.** Izolowany GET HTML/JS/CSS + `liveDistUnchanged`. Brak kliknięcia Settings → Delegacje (Playwright) na instancji z HMR=0 i starym dist.
3. **D8.** `registerMockChatRunAdapter(transport)` na sześciu etykietach to nie integration per adapter. Live płatne = odroczone (zakaz).
4. **D4.** `POST .../retry-delivery` nadal pozwala pominąć `mailboxId`, gdy jest 0 albo 1 wiadomość `failed|uncertain`. Kontrakt: mutacja **wskazanej** wiadomości.
5. **Macierz B.** Dwa klienty / utrata odpowiedzi / anulowane `confirm` bez mutacji — nie jako osobny test III. Stop/ack = mock-adapter, nie Playwright na izolowanym serwerze.
6. **D1 pkt 5.** Crash między wynikiem a outbox jest w `delegation-audit-fixes` dla `finishDelegation`, niekoniecznie dla ścieżki narzędzia `final_report` + fencing próby.

D7 i D9 izolowane zostają. Nie przepisywać store/migratora.

## Zasady (wiążące)

- Nie commit bez polecenia.
- Nie kopiować i nie migrować aktywnego `data/`.
- Nie Stop / Retry / ack / retry-delivery na jobach użytkownika w live `data/`.
- Bez płatnych modeli, chyba że ten TODO ma jawny budżet (domyślnie **brak**).
- Nie dublować TODO sesji DeepSeek (`a533e1cc` i pokrewne).
- Zachować regresje: `delegation-phase3*.test.js`, phase2 / phase2b e2e, Playwright phase2b, mailbox, delivery-acceptance, outbox-concurrency, review-followup, mcp-builtin, prompt.
- Restart `:3011` **dozwolony** wyłącznie w E1, po kodzie E4, żeby załadować drzewo robocze. Zanotować nowy `serverInstanceToken` (bez sekretów). Nie crash-testować produkcji.

## Dostawa A — kod i testy izolowane

### E4 / P1 — `mailboxId` zawsze wymagane

`POST /api/delegations/:id/retry-delivery` odrzuca brak `mailboxId` / `messageId` także przy 0 i 1 wiadomości. Kod `mailbox_id_required`. UI zawsze wysyła `data-mailbox-id`. Test: 0, 1 i 2 wiadomości; obca id → 404; druga wiadomość nietknięta.

### E5 / P1 — Idempotencja mutacji (dziura macierzy B)

Dwa równoległe `retry-delivery` tej samej wiadomości: najwyżej jeden skutek ponowienia. Utrata odpowiedzi HTTP + powtórzenie tego samego żądania: brak drugiej mutacji. Anulowane `window.confirm` w centrum: zero requestów. Retry-task: dokładnie +1 próba przy podwójnym POST (CAS / in-flight). Nie „attemptCount >= 2”.

### E6 / P1 — Crash na ścieżce `final_report`

Zastrzyk awarii po trwałym wyniku próby, przed outbox/mailbox (lub odwrotnie). Recovery: raport nie ginie, nie powstaje drugi run, fencing `attemptId` zostaje. Nie zastępować tego istniejącym testem samego `finishDelegation` sprzed III.

## Dostawa B — UI HMR=0 i adaptery

### E2 / P1 — D5 jako ekran, nie GET

Izolowany port + `CRETLI_PUBLIC_DIR` poza live `public/dist`. Start ze **starego** dist (bundle bez centrum albo poprzedni hash), one-shot `CRETLI_FRONT_HMR=0 webpack --config webpack.dev.js --no-watch --output-path <izolowany>`. Playwright: wejść w Settings → Delegacje, zobaczyć listę/filtry (nie sam string w pliku). `liveDistUnchanged=true`. Skip ≠ PASS. Nie pisać do live dist.

Można rozszerzyć `playwright.delegation-phase2b.config.js` albo nowy `playwright.delegation-phase3b.config.js`. Chromium: `/usr/bin/chromium` na Debian 11.

### E3 / P1 — D8 bez udawania mocka za 6 transportów

Macierz: opencode, openrouter, codebuddy, deepseek, qwen, codex.

Dla każdego wiersza osobno: ścieżka w `lib/` (nie `registerMockChatRunAdapter(nazwa)`), coverage `unit` / `integration` / `live`.

Wymagane dowody tam, gdzie kod adaptera istnieje lokalnie bez sieci płatnej:

- review: odczyt fixture, odmowa `write_file` **zanim** skutek uboczny (guard tego transportu, nie tylko `executeTool` w trybie plan).
- cancel: wywołanie **cancel/stop tego adaptera** (moduł `*-agent-ws` / chat-run adapter), potwierdzony koniec runu w stanie tego adaptera.

Mock ogólny może zostać jako kontrola service, ale **nie** jako `integration=pass` dla wszystkich sześciu. Brak lokalnego SDK = `integration=deferred` z powodem, nie PASS. Live = deferred bez budżetu.

## Dostawa C — live odczyt (po A)

### E1 / P1 — Proces z kodem III/IIIb

Po restarcie `:3011` z drzewa `next/2026-09-06`:

- `GET /api/delegations/runtime` (sesja): `processAlive` vs `workerRunning`, lifecycle, tick nie wiecznie stale, backend, liczniki bez treści promptów. Token procesu.
- MCP: `delegation_reply` ma `attempt_id` / `run_id` / `task_outcome`; kody CONFLICT obejmują `still_active` i `parent_busy` (odczyt schematu/narzędzia, **nie** start live joba).
- Settings → Delegacje: zrzut ekranu albo równoważny dowód, że centrum jest z **tego** procesu (mtime bundla / token). Bez mutacji cudzych jobów.

Brak sesji = 401; wtedy użyć istniejącego mechanizmu sesji testowej, nie zgadywać.

Rekordy `running` bez dowodu końca próby zostawić `unknown` / bez auto-cancel. Nie czyścić skrzynki użytkownika.

### E7 / P2 — Live adapterów

Poza zakresem bez budżetu w tym TODO. W raporcie: `live=deferred-no-paid-models`.

### E8 — D10

Poza zakresem. Nie implementować puli.

## Kolejność

1. E4, E5, E6 (kod + testy izolowane).
2. E2, E3.
3. E1 (restart `:3011`).
4. E7 odroczyć jawnie. E8 nie startuje.

## Raport wykonawcy

Tabela E1–E8 (PASS / FAIL / odroczone + dowód). Lista testów. Czy ruszano `:3011` i jaki token. Ograniczenia. Bez „wszystkie bramki ukończone”, jeśli E3 ma deferred albo E1 bez sesji.

## Zamykanie TODO

`done` tylko gdy E4, E5, E6, E2 mają dowody izolowane oraz E1 ma odczyt procesu **albo** jawną blokadę (brak sesji / proces nie wstał) w ciele TODO — nie ciche pominięcie. E3: każdy wiersz PASS albo deferred z powodem. E7 deferred. E8 nietknięte.
