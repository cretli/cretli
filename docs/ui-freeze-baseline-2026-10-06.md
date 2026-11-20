# UI freeze — baseline replay lifecycle (0.1, trace 2026-10-06)

Data: 2026-10-06. Zakres: liść **0.1** etapu 0 planu
(`33e307a2-741d-4ec1-94d4-2aa0a94616bb`) — **instrumentacja pełnego async replayu**
bez zmiany zachowania renderu (unieważnianie starych pętli to etap 1).

Powiązane materiały:

- diagnoza trace: `docs/ui-freeze-trace-2026-10-06.md`,
- wcześniejsza instrumentacja listy/boot-cache: `docs/ui-freeze-baseline-2026-10-05.md`.

## Jak włączyć

Identycznie jak w baseline 2026-10-05:

- `?uiFreezeDiag=1` albo `localStorage['cretli-ui-freeze-diag'] = '1'`,
- Logs → filtr **freeze**.

Przy wyłączonej fladze moduł lifecycle nie emituje spanów ani logów; generacja
replayu nadal rośnie w widoku (tanie liczniki), ale bez narzutu na budżet perf.

## Nowe zdarzenia `history-replay:*`

Moduł: `app_front/lib/chatHistoryReplayLifecycle.js`, integracja w
`app_front/lib/sdk-rich-view.js` (`replayHistoryRecords`,
`replayHistoryRecordsChunkedImpl`, `destroy`).

| Zdarzenie | Kiedy | Pola (skrót) |
| --- | --- | --- |
| `start` | początek replayu | `generation`, `source`, `totalRecords`, `syncHead`, `trackAsync`, `activeAsyncLoops` |
| `sync-end` | po pierwszych N rekordach synchronicznych | `syncApplied` |
| `async-start` | wejście w pętlę chunked | `generation`, `activeAsyncLoops` |
| `batch` | co 8 rekordów (apply + yield rAF) | `batchIndex`, `applyMs`, `yieldMs`, `batchMs`, `applied` |
| `destroy-async-complete` | tail async po `destroy()` widoku | `generation`, `applied` |
| `async-end` | zakończenie pętli chunked | `reason`, `activeAsyncLoops` |
| `supersede` | nowy replay zamyka span poprzedniego | `previousGeneration`, `nextGeneration`, `appliedBeforeSupersede` |
| `stale-complete` | stara pętla kończy się po supersede | `generation`, `applied` |
| `end` | zamknięcie spanu `history.replay` | `reason`, `durationMs`, `applied`, `batches` |
| `destroy` | `destroy()` widoku | `generation`, `applied` |

Źródło (`source`) ustawia `chat.js`:

- `local` — hydratacja z cache (IndexedDB / legacy),
- `http` — pełny replay po pullu serwera,
- `sdk-api` — okno po `Agent.messages.list`.

Liczniki w snapshot (`history.replay.starts`, `.batches`, `.supersedes`,
`.staleCompletes`) trafiają do `freeze-counters:snapshot`.

## Kontrakt spanu `history.replay`

**Przed 0.1:** `measureRenderSpan('history.replay')` obejmował tylko pierwsze
20 rekordów; tail async nie był przypisywany do spanu (long-task widział `idle`
lub krótki sync).

**Po 0.1 (diag włączony):** jeden span od `start` do `end` / `superseded` /
`destroyed`, z `cards=totalRecords` i `applied` rosnącym do końca async.
Paczki po 8 rekordach logują `applyMs` (koszt `applyHistoryRecord` w paczce),
`yieldMs` (oczekiwanie na rAF) oraz `batchMs = applyMs + yieldMs`; zdarzenie
`async-end` niesie `finalizeMs` (commit/layout po pętli w `finally`).

Stałe: `HISTORY_REPLAY_SYNC_HEAD = 20`, `HISTORY_REPLAY_CHUNK_SIZE = 8`
(`chatHistoryReplayLifecycle.js`).

## Scenariusz reprodukcji (manualny, bez prywatnych danych w repo)

1. Viewport **1920×525** (z trace 2026-10-06) lub dowolny desktop — ważne, żeby
   zapisać w notatce.
2. Duży czat SDK: **>20 rekordów** w oknie (tail=80 może rozszerzyć do setek —
   patrz diagnoza trace).
3. Włączyć `uiFreezeDiag=1`, przeładować.
4. Otworzyć czat → poczekać na hydratację **local**, potem dokończenie **http**
   (w logach: kolejne `history-replay:start` z `source=local` potem `http` albo
   supersede + `stale-complete`).
5. Szybko przełączyć na inny czat i z powrotem — oczekiwane: `supersede`,
   `activeAsyncLoops` > 1 chwilowo, ewentualnie `stale-complete`.
6. Opcjonalnie: czat z raportem delegacji ~**800 KB** (istniejące dane u
   użytkownika — **nie** commitować do repo); w trace widać skok DOM przy
   `renderDelegationCard` / `renderMailboxCard`.

Fixture syntetyczny (**52** rekordy, jeden ~800 KB): generowany deterministycznie
przez `scripts/generate-synthetic-history-replay-fixture.mjs` →
`tests/fixtures/synthetic-history-replay-records.json`.

Test integracyjny (Node, bez przeglądarki):
`tests/chat-history-replay-integration.test.js` — local → HTTP (supersede) →
`destroy()` + tail async, weryfikacja spanów i dużego rekordu.

## Baseline liczbowy — pomiar harnessowy (2026-10-06)

**Typ:** Node harness (`scripts/measure-history-replay-lifecycle-baseline.mjs`),
**nie** Chrome Performance trace (pełny trace Chromium pozostaje celem etapu 5).

Viewport: n/a (symulacja bez DOM). Fixture: 52 rekordy, duży rekord ≈819 KB.

| Metryka | Wartość |
| --- | ---: |
| Median pełny async replay wall ms (diag **on**) | 4,73 |
| Median pełny async replay wall ms (diag **off**) | 4,46 |
| Narzut diagnostyki (median delta) | 0,27 ms (~6,2%) |
| `HISTORY_REPLAY_SYNC_HEAD` | 20 |

## Baseline liczbowy z trace 2026-10-06 (referencja Chromium — etap 5)

| Metryka | Wartość |
| --- | ---: |
| Czas nagrania | 35,79 s |
| Long tasks >50 ms | 114 |
| Max long task | 3361,5 ms |
| Max interaction latency | 2448,8 ms |
| UpdateLayoutTree | 10 658 ms |
| Commit | 7347 ms |
| Replay async inclusive (CPU) | ~12 450 ms |
| Nodes | 33 093 → 509 961 |

Te liczby **nie** są powtarzalne bez tego samego profilu danych; służą jako
target regresji dla etapu 5. Po 0.1 oczekiwany efekt w Logs: pełny
`history.replay` span obejmujący tail async, nie tylko sync 20.

## Ograniczenia (otwarte na etap 1+)

- Stara pętla chunked **nadal może** dokończyć po supersede (pomiar:
  `stale-complete` dla `superseded`, `destroy-async-complete` dla `destroyed`);
  **zatrzymanie** starej pętli to etap 1 — bez zmian w 0.1.
- Przy wyłączonym diag produkcyjny span nadal kończy się po sync (brak narzutu).
- Coverage / ACK w `chat.js` nadal ustawiane przed końcem async — bez zmian w 0.1.
