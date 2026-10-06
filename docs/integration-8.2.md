# Integracja archiwum, offline i wielu kart (liść 8.2)

Data: 2026-10-06. Workspace: `/path/to/cretli`. Liść weryfikuje
współdziałanie etapów 0–7 (P0, IDB/offline, Lit sidebar, wirtualizacja
archiwum) bez pełnego trace CPU w Chrome.

Powiązane: `docs/ui-freeze-baseline-2026-10-05.md` (budżet 0.1),
`docs/performance-8.1.md`, `docs/chat-metadata-idb-isolation.md`,
`playwright.chat-metadata-idb.config.js`.

## Playwright E2E (history sync harness)

Komenda:

```bash
npx playwright test --config playwright.chat-history-sync.config.js
```

Wynik po poprawce rundy 2 (2026-10-06): **13/13 passed** (~6 s).

| Uwaga | Szczegół |
| --- | --- |
| Wcześniejszy fail (review rundy 2) | `recovered B1 sits before live B2; both stay after A102` — odzyskany `new B1` lądował **przed** live `old A102` (indeks 2 vs 3). |
| Diagnoza | **Regresja realna** w ścieżce DOM (nie flaky harnessu). Dowód: `git stash` plików poprawki (`sdk-rich-view.js`, `chatHistoryViewOrder.js`, test jednostkowy) → ten sam test **1 failed**; po `git stash pop` → **1 passed**. |
| Przyczyna | `readElementOrderKey` brało `createdAt` z wall-clock `<time>` / `block.createdAt` na kartach live bez `historySeq`. HTTP catch-up (`2026-09-19…`) porównywał się z „teraz” i wpychał kartę przed starszy live stream A. |
| Naprawa | Tylko trwałe znaczniki czasu do kolejności widoku; guard w `shouldPlaceViewCardBefore` dla live-only + świeży `createdAt`. Test: `tests/chat-history-view-order.test.js`. |

## Playwright E2E (metadata IDB harness)

Komenda:

```bash
npx playwright test --config playwright.chat-metadata-idb.config.js
```

Wynik (2026-10-06): **6/6 passed** (~1,3 s).

| Test | Scenariusz integracyjny |
| --- | --- |
| round-trip chat row | zapis/odczyt wiersza bez pól runtime |
| session boundary | granica sesji czyści metadane, **nie** `cretli-sdk-chat` |
| versionchange and module abort | status `aborted` / `versionchange` |
| blocked upgrade | druga karta trzyma DB → `blocked` |
| logout during write | 401/logout w trakcie zapisu — brak resurrect stale |
| late kv read after auth boundary | `stale-session`, wartość `null` |

Pełny UI (reload, archiwum 942 wierszy, poll ≥20 s, input/scroll, offline
cold start w DevTools) pozostaje scenariuszem manualnym jak w baseline 0.1
(sekcja «Ograniczenia»); w tej sesji nie powtórzono trace `Trace-*.json`.

## Regresje Node (wybrane)

Wszystkie poniższe zakończone **exit 0** (2026-10-06):

```bash
node tests/chat-metadata-idb.test.js
node tests/chat-metadata-idb-schema.test.js
node tests/chat-metadata-cross-tab.test.js
node tests/chat-session-boundary.test.js
node tests/chat-local-boot-sync.test.js
node tests/chat-local-boot-cache.test.js
node tests/chat-persistence-idb-queue.test.js
node tests/chat-persistence-queue.test.js
node tests/chat-pending-remote-history.test.js
node tests/chat-list-load-scope-guard.test.js
node tests/chat-list-load-freshness.test.js
node tests/chat-history-sync-poll.test.js
node tests/chat-history-revisions-explicit-fetch.test.js
node tests/chat-list-pending-badges.test.js
node tests/chat-list-activity-prune.test.js
node tests/chat-list-archive-freshness.test.js
node tests/ui-freeze-counters.test.js
node tests/sidebar-archive-virtualizer.test.js
node tests/sidebar-archive-virtual-a11y.test.js
node tests/sidebar-archive-virtual-dom.test.js
node tests/sidebar-lit-migration-contract.test.js
node tests/sidebar-chat-row.test.js
node tests/sidebar-layout-dedup.test.js
node tests/sidebar-transient-patch.test.js
node tests/sidebar-workspace-order.test.js
node tests/agent-presence-store.test.js
node tests/chat-hot-path-slice.test.js
node tests/monitoring-archive-qualification.test.js
node tests/scheduler-yield.test.js
node tests/chat-archive-data-source.test.js
node scripts/measure-ui-freeze-baseline.mjs
```

## Pokrycie integracyjne (co sprawdzono)

| Obszar | Dowód |
| --- | --- |
| Migracja legacy boot → IDB | `chat-local-boot-sync.test.js` (nowszy IDB wygrywa, idempotentność) |
| abort / quota / niedostępne IDB | `chat-metadata-idb.test.js`, Playwright abort/versionchange/blocked; `idb-unavailable` przy migracji legacy → `chat-local-boot-sync.test.js` |
| blocked / versionchange / dwie karty | Playwright + `chat-metadata-cross-tab.test.js` |
| logout / 401 / granica sesji | Playwright + `chat-session-boundary.test.js`, kolejka po boundary |
| Wyścigi HTTP (lista) | `chat-list-load-scope-guard.test.js` (token apply po yield, anulowanie) |
| Poll / pending / viewAppliedSeq / ACK | `chat-pending-remote-history.test.js`, `chat-history-sync-poll.test.js` |
| Późny cache / kontynuacje | `chat-list-load-freshness.test.js`, scope guard, session apply |
| active / watcherPinned (boot cap) | `chat-local-boot-sync.test.js`, `chat-list-ranking-prepared-keys.test.js` |
| monitoring archiwum (bez rozszerzenia przy otwarciu archiwum) | `monitoring-archive-qualification.test.js` |
| Archiwum / focus / wirtualizacja / a11y | `sidebar-archive-virtualizer.test.js`, `sidebar-archive-virtual-a11y.test.js` |
| Lit sidebar / selektory / drag hostów | `sidebar-lit-migration-contract.test.js`, `sidebar-chat-row.test.js`, `sidebar-chat-drag-block.test.js` |
| Favorites / grupy subchat | `sidebar-subchat-groups.test.js`, `sidebar-lit-lifecycle.test.js` |
| Swipe (mobile sidebar) | `sidebar-swipe.test.js` |
| Powrót z tła / resume listy | `chat-resume-policy.test.js`, `chat-list-resume-sync.test.js`, Playwright history-sync **13/13** (patrz sekcja powyżej) |

**Nie objęte review-verify (audyt):** pełny Playwright UI Cretli (wymaga sieci i
`data/`), `sidebar-archive-virtual-dom.test.js` (~14 s jsdom — uruchamiać
jako `node tests/...`, nie w katalogu), e2e DOM w `tests/sidebar-*-dom/`.

## Review-verify — nowe id katalogu

Rejestracja: `lib/sdk/sdk-review-verify.js` (`REVIEW_VERIFY_CATALOG`,
`REVIEW_VERIFY_PATH_SELECTORS`, `resolveReviewVerifyIdsForPath`).

| Id | Plik testu |
| --- | --- |
| `chat-list-load-scope-guard` | `tests/chat-list-load-scope-guard.test.js` |
| `chat-local-boot-sync` | `tests/chat-local-boot-sync.test.js` |
| `chat-metadata-cross-tab` | `tests/chat-metadata-cross-tab.test.js` |
| `chat-metadata-idb` | `tests/chat-metadata-idb.test.js` |
| `chat-pending-remote-history` | `tests/chat-pending-remote-history.test.js` |
| `chat-session-boundary` | `tests/chat-session-boundary.test.js` |
| `monitoring-archive-qualification` | `tests/monitoring-archive-qualification.test.js` |
| `sidebar-archive-virtual-a11y` | `tests/sidebar-archive-virtual-a11y.test.js` |
| `sidebar-archive-virtualizer` | `tests/sidebar-archive-virtualizer.test.js` |
| `sidebar-chat-drag-block` | `tests/sidebar-chat-drag-block.test.js` |
| `sidebar-lit-migration-contract` | `tests/sidebar-lit-migration-contract.test.js` |
| `sidebar-swipe` | `tests/sidebar-swipe.test.js` |
| `chat-resume-policy` | `tests/chat-resume-policy.test.js` |
| `chat-list-resume-sync` | `tests/chat-list-resume-sync.test.js` |

Selektory ścieżek (przykłady — pełna lista w kodzie):

| Wzorzec (repo-relative) | Id do uruchomienia |
| --- | --- |
| `app_front/features/chat/chatMetadataIdb*.js` | `chat-metadata-idb`, `chat-metadata-cross-tab`, `chat-session-boundary` |
| `app_front/features/chat/chatLocalBoot*.js` | `chat-local-boot-sync`, `ui-freeze-counters` |
| `app_front/features/chat/chatController.js` | `chat-list-load-scope-guard`, `chat-pending-remote-history` |
| `app_front/features/chat/chatBackgroundPolicy.js` | `monitoring-archive-qualification`, `ui-freeze-counters` |
| `app_front/features/sidebar/sidebarArchive*.js` | `sidebar-archive-virtualizer`, `sidebar-archive-virtual-a11y`, `sidebar-lit-migration-contract` |
| `app_front/features/sidebar/sidebarSwipe.js` | `sidebar-swipe` |
| `app_front/features/sidebar/sidebarChatDragBlock.js` | `sidebar-chat-drag-block`, `sidebar-lit-migration-contract` |
| `app_front/features/chat/chatLocalBootLegacyMigration.js` | `chat-local-boot-sync` (w tym `idb-unavailable`) |
| `app_front/lib/pageResumeCleanup.js` / `chatListResumeSync.js` | `chat-resume-policy`, `chat-list-resume-sync` |

Komendy:

```bash
node scripts/review-verify.js chat-metadata-idb chat-session-boundary
node scripts/review-verify.js chat-list-load-scope-guard chat-pending-remote-history monitoring-archive-qualification sidebar-archive-virtualizer sidebar-lit-migration-contract chat-local-boot-sync chat-metadata-cross-tab sidebar-lit-migration-contract
node tests/review-verify.test.js
```

Wynik (2026-10-06): `review-verify.test.js` **OK**; pełna paczka 8.2 id w
izolowanym `CRETLI_DATA_DIR` — **OK**.

## Budżet pierwszego malowania offline (0.1)

Źródło liczb: `docs/ui-freeze-baseline-2026-10-05.md`, pomiar syntetyczny:

```bash
node scripts/measure-ui-freeze-baseline.mjs
```

Wynik (2026-10-06, Node v22.23.2):

| Metryka | Budżet 0.1 | Zmierzone |
| --- | ---: | ---: |
| Parse snapshot ≤40 wierszy | ≤5 ms | mediana **0,04 ms**, max 0,14 ms |
| Rozmiar JSON ≤40 wierszy | ≤64 KB | **7712 B** |
| `boot-cache.build` @ 40 | (informacyjnie) | **0,05 ms** mediana |

Cel **≤100 ms** pierwszego malowania listy (parse + hydratacja + render) w
przeglądarce offline nadal wymaga powtórzenia scenariusza z baseline (DevTools
Network offline + reload); parse/hydratacja synchroniczna mieści się w budżecie
z dużym zapasem.

## Odstępstwa

- Brak nowego `Trace-*.json` i brak pomiaru ≤100 ms w panelu Browser (jak w 8.1
  i baseline 0.1).
- Powrót z tła i swipe — testy jednostkowe (`chat-resume-policy`, `chat-list-resume-sync`,
  `sidebar-swipe`); resume/history sync w harnessie Playwright (13/13 po poprawce
  kolejności catch-up vs live).
- `npm test` — nie uruchamiano całości; znane 5 pre-existing failów poza zakresem
  liścia.

## Pliki zmienione (liść 8.2)

- `lib/sdk/sdk-review-verify.js` — katalog id 8.2, selektory ścieżek, resolver.
- `tests/review-verify.test.js` — guard izolacji dla id 8.2.
- `docs/integration-8.2.md` — ten raport.
- `app_front/lib/sdk-rich-view.js` — `readElementOrderKey`: durable `createdAt` tylko z `dataset` / `historySeq`.
- `app_front/features/chat/chatHistoryViewOrder.js` — guard wall-clock w `shouldPlaceViewCardBefore`.
- `tests/chat-history-view-order.test.js` — regresja catch-up vs live wall-clock.
