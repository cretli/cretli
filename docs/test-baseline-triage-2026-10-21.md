# Triage porażek testów bazowych (2026-10-21)

Commit `6f2d03e9`, Node 22.23.3, `node scripts/run-unit-tests.mjs`: **24/1083** plików
padało na czystym drzewie. `sdk-chat-history-queue` był osobnym zadaniem (naprawiony:
fake `navigator.locks` + ograniczone oczekiwanie, runner ma limit czasu na plik).
Pozostałe 23 pliki uruchomiono pojedynczo ze świeżym `CRETLI_DATA_DIR`: każdy pada
deterministycznie. Nie ma tu ani `isolation`, ani `flaky`.

Triage wykonał subagent. Dwa twierdzenia (zły JSON allowlisty, literały w `app.scss`)
zostały sprawdzone ręcznie, reszta to jego diagnoza.

## Poza testami (do naprawy w kodzie lub decyzji)

| plik | problem | propozycja |
| --- | --- | --- |
| `config/delegation-controller-allowlist.json` | niepoprawny JSON od `018b3d72`: brak przecinka po wpisie `findInheritableImplementVerify` (l. 146), wpis zduplikowany (l. 148); czyta go tylko `delegation-controller-guard.test.js` | dodać przecinek, usunąć duplikat |
| `app_front/css/app.scss` | 4 surowe `font-size` (l. 39, 69, 96, 101) od `c03a0f14` łamią `ui-tokens-lint` | tokeny `--cr-font-size-*` |
| `sidebar-delegation.test.js:69` | oczekuje `sidebar-chat-mute-btn`, którego `sidebarView.js` nigdy nie miał (test z `727d243b`) | **decyzja**: czy przycisk wyciszenia w sidebarze miał wejść? |

## Testy do aktualizacji

| plik | klasa | przyczyna | propozycja |
| --- | --- | --- | --- |
| architecture-acceptance | stale | manifest `architecture-manifest-stage7.json` przypina sha/bajty 44 żywych plików | zregenerować albo przypinać tylko zamrożone dokumenty |
| can-use-tool-permission-flow | test-harness | czeka na `unref()`-owany timer (`can-use-tool-permission.js:225`), pętla zdarzeń się kończy | ref'owany keep-alive albo `mock.timers` |
| storage-coordinator | test-harness | jw., timer drain `coordinator.js:708` | jw. |
| chat-list-title-patch | stale | `skip-fresh` w `chatListLoadFreshness.js` | `forceRefresh: true` (zweryfikowane) |
| persisted-local-chat-state-ui | stale | jw. | jw. (zweryfikowane) |
| delegation-code-review-phase | stale | `isReviewerMemberStartable` (`5c37d434`) odrzuca fałszywych recenzentów | stub `isMemberStartable` |
| delegation-list-compact | stale | nowe pola `allow_recheck`, `work_role` | dopisać do oczekiwanego wiersza |
| delegation-workflow | stale | `workRole` w hashu żądania (`a286c2bc`) | `workRole: 'implement'` w teście |
| harness-snapshot-registry | stale | nowe pola `review_*` w katalogu (`3a50221a`) | rozszerzyć `BUILTIN_ROW_KEYS` |
| model-alias-policy | stale | Codex domyślnie certyfikowany do review (`5b6a3519`) | env `CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX=0` |
| orchestrator-leaf-resolution | stale | `continue_implement_sessions` domyślnie `true` (`1bbcdaa7`) | wyłączyć w teście albo oczekiwać 409 |
| reviewer-policy | stale | jw. | zaktualizować oczekiwane linie |
| recovery-contract | stale | nowy powód `review_cancel_stuck` (`90ce17f9`) | dopisać |
| sidebar-chat-status | stale | ikona `mdi-help-circle-outline` (`43eb6501`) | zaktualizować regex |
| todos-persist-cache | stale | checkpoint leaf-material ponownie grzeje cache | zmieniać tytuł zamiast statusu |
| view-memory-panel | stale | brak `createBatchActions` w kontekście vm (`576b0167`) | dodać stub |
| watcher-panel-workspace-race | stale | `syncBarCollapse` (`b24ca30e`) wymaga `classList`/`querySelector` | uzupełnić fałszywy pasek |
| worktree-todo-mode | stale | `dirtyPolicy: 'block'` (`6cd551a7`) | dopisać |
| chat-history-isolation | env | brak `rg` lokalnie (CI ma) | — |
| offline-snapshot-guards | env | root + Node pod `/root` (uid 65534 nie wykona binarki); CI nie jest rootem | opcjonalnie skip |

Wspólne przyczyny: 11 plików przypina strukturę, która od tego czasu urosła;
2 to zmiana domyślnego `continue_*_sessions`; 2 to TTL `skip-fresh`; 2 to
`unref()`-owane timery; 2 to ręczne konteksty vm/DOM; 2 to środowisko.

## Fix: delegation-* test failures (10 files)

All ten files failed on HEAD for one shared cause: an **outdated test
environment, not a code regression**. The shell that runs the suite exports
`CRETLI_DELEGATION_STORE=sqlite`. `getDelegationStoreBackend()` lets that
variable win over `setDelegationStoreBackend()`, whose process default is
`json`. These tests assume the JSON store (they read or write
`delegations.json`, count whole-file writes or reads, or compare the json and
sqlite accessors), so with the variable set they hit the sqlite store and failed.

Fix (single change): `tests/helpers/isolated-data-dir.js` now deletes
`CRETLI_DELEGATION_STORE`. Tests that need sqlite already select it explicitly
with `setDelegationStoreBackend('sqlite')`, so no test loses coverage. No
`lib/` change was needed and no assertion was weakened.

| File | Cause | Fix | Result |
| --- | --- | --- | --- |
| delegation-audit-fixes | Outdated test env: reads `delegations.json` while the env forced sqlite (ENOENT) | Helper clears the env override | pass |
| delegation-mailbox | Same: ENOENT on `delegations.json` | Same | pass |
| delegation-persist-bench | Same: JSON-store write/read counters saw sqlite | Same | pass |
| delegation-phase2-review | Same: JSON fixture files ignored by the sqlite backend | Same | pass |
| delegation-phase2-runtime | Same | Same | pass |
| delegation-retention | Same: "one mailbox write" count measured the JSON file | Same | pass |
| delegation-runtime-worker | Same: ENOENT on `delegations.json` | Same | pass |
| delegation-store-cache | Same: "batch update rewrites the store once" counts JSON file writes | Same | pass |
| delegation-store-equivalence | Same: json-vs-sqlite comparison collapsed to sqlite on both sides | Same | pass |
| delegations-persist-cache | Same: JSON read counter saw 0 reads | Same | pass |

Verification: each file run alone with `node --test tests/<file>.test.js`
(all pass; retention 8, store-cache 4, store-equivalence 6 subtests), then the
full `npm test -- --jobs 4`.
