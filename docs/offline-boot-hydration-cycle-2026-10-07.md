# Offline bootstrap — handoff po cyklu 6941cb15 (2026-10-07)

**Status: cykl NIE mógł zakończyć się raportem watchera.** Serwer Cretli ma zablokowaną
persystencję od ~09:18 UTC (wszystkie pliki `data/*.json` zamrożone na 11:18 czasu
lokalnego; most MCP/`workspace_watcher_update`/`delegation_show` kończą się
`Cretli API request timed out`, mimo że `/api/health` odpowiada). Job fix r2
(`f2d974e7-cabc-4777-8408-e8b7ea704b25`) wisi jako `running`, choć proces dziecka
(chat `1593e4e2-…`) już nie istnieje — serwer nie zapisał stanu terminalnego.

- Todo: `1a336b36-6c1b-4da4-a613-229cfa0d5690` („Offline bootstrap: odtworzyć hydratację czatu")
- Cykl: `6941cb15-4e57-4017-b53d-633f2f793a44`, chat orkiestratora `5e1ea3c3-1195-460d-86fd-47f43f2f75fb`
- Data: 2026-10-07, workspace `/path/to/cretli`, HEAD `79b8329` + dirty

## Co ustalono (przyczyna i dowody)

1. Pierwotna przyczyna braku hydratacji offline: `app_front/App.js`
   `ensureAuthenticatedThenBoot()` w `.catch()` pokazywał nakładkę „Cretli could not start"
   i ponawiał co 4 s — `bootApp()` nigdy nie było wołane. SW celowo omija `/api/*`
   (`public/sw.js:242`), więc `/api/auth-status` offline zawsze zawodzi.
2. Wtórna przyczyna: `buildChatLocalBootSyncDoc()` wkładał do 64 KB dokumentu sync
   pełny `fullSignature` (~78 KB), więc zapis `cretli-chat-boot-sync-v1` zwracał `false`.
3. Po fixie offline cold start DZIAŁA. Dowód rodzica (prod build):
   `.tmp/offline-hydration/fix-verify-active.json` — `?chat=fabd16a3-…` offline:
   hydration 364 ms, cards=8, activeChat OK, brak nakładki, FCP 30 ms,
   IDB snapshot **92010 B / 140 czatów przed i po** (brak shrinku), sync 32080 B / 40.

## Historia rund (wszystko w `data/delegation-workflows.json` do 09:18 UTC)

| Runda | Job | Model | Wynik |
|---|---|---|---|
| implement | `487c2ae6…` | deepseek/deepseek-flash | PASS (dodał `chatBootDecision.js`, `chatOfflineBootSeed.js`, harness, docs) |
| review r1 | `16f655da…` | sdk/grok-4.7 | FAIL — B1 (offline boot kurczy IDB 120→40), B2 (żądany czat spoza okna 40) |
| fix r1 | `2c563da0…` | sdk/composer-2.5 | FAIL raportu (probe padł na niespójnym buildzie dev/prod), kod B1/B2 na dysku |
| review r2 | `bad815c7…` | claude/claude-opus-5-5 | FAIL — F1 (guard shrinku zbyt szeroki: blokuje legalne 41→40, zamraża snapshot/sync, duchy), F2 (B2 bez dowodu; `CRETLI_PROBE_NON_ACTIVE` sprzeczny; brak testu gałęzi kontrolera); F3–F8 nieblokujące |
| fix r2 | `f2d974e7…` | deepseek/deepseek-flash | **wisi `running`** — dziecko wyszło, serwer nie zapisał stanu; kod F1/F2 na dysku |

Findings r2 są zapisane trwale: `data/workspace-watchers.json` →
`items["/path/to/cretli"].findings.byTodo["1a336b36-…"]`,
hash `9af26ea51705c24f510e1dd8855cbaf4ecf531dab9bacf088df2385c8e419754`.

## Stan kodu na dysku (po fix r2, przed review r3)

Zmodyfikowane: `app_front/App.js`, `app_front/features/chat/chatController.js`,
`app_front/features/chat/chatLocalBootCache.js`,
`app_front/features/chat/chatLocalBootSync.js`.
Nowe/nieśledzone: `app_front/features/chat/chatOfflineBootSeed.js`,
`scripts/offline-boot-hydration-probe.mjs`, `tests/chat-boot-offline-decision.test.js`,
`docs/offline-boot-hydration-2026-10-07.md`, `app_front/features/chat/chatBootDecision.js`.

## Co zrobić po odzyskaniu serwera (next cycle)

1. Sprawdź, czy job `f2d974e7…` ma terminalny stan (jeśli nadal `running` z martwym
   dzieckiem — potraktuj jako infra failure, zwolnij slot).
2. Zweryfikuj diff fix r2 pod kątem F1/F2:
   - F1: decyzja o pominięciu zapisu IDB oparta na jawnym sygnale
     „boot-cache/niepotwierdzone przez serwer" (nie na progu 40) + test 41→40
     (źródło serwerowe zapisuje, boot-cache nie kurczy).
   - F2: harness `CRETLI_PROBE_NON_ACTIVE=1` naprawdę testuje żądany czat != aktywny
     (lub `CRETLI_CLEAR_SYNC_BEFORE_OFFLINE=1` + żądany != aktywny); test gałęzi
     `preferChatId` w `chatController.js`; `SETTLE_MS` i asercja sidebara; docs zgodne z JSON.
3. Uruchom: `node tests/chat-local-boot-sync.test.js` (11/11),
   `node tests/chat-boot-offline-decision.test.js`, `node tests/chat-local-boot-cache.test.js`,
   `node tests/ui-freeze-counters.test.js`, `node tests/chat-history-hydration-live.test.js`,
   `node scripts/review-verify.js chat-local-boot-sync`,
   `node scripts/offline-boot-hydration-probe.mjs <niearchiwalny-czat> .tmp/offline-hydration/r3`.
4. Jeśli build frontu jest niespójny (objaw „Cretli could not start", entry oczekuje
   chunku `vendor`, a na dysku numeryczne): `npm run prod -w cretli-front` (15 s).
5. Review r3 na innym modelu (wyklucz deepseek-flash i claude-opus-5-5), potem dopiero
   `todo_update` status `done`.

## Lokalna walidacja kodu fix r2 (bez serwera, po zawieszeniu)

Uruchomione po zamrożeniu persystencji (testy nie wymagają MCP):

- `node tests/chat-local-boot-sync.test.js` — 11/11
- `node tests/chat-boot-offline-decision.test.js` — **26/26** (było 18 przed fix r2, czyli
  doszły testy F1/F2)
- `node tests/chat-local-boot-cache.test.js` — 1/1
- `node tests/ui-freeze-counters.test.js` — 1/1
- `node tests/chat-history-hydration-live.test.js` — 1/1
- `node scripts/review-verify.js chat-local-boot-sync` — 11/11

Probe live po fix r2 NIE został uruchomiony: serwer przestał odpowiadać na nawigację
(`page.goto` timeout 60 s), więc `scripts/offline-boot-hydration-probe.mjs` trzeba
powtórzyć po restarcie. Nie oznacza to PASS hydratacji po fix r2 — brak dowodu live
dla tej rundy.

## Znane pułapki niezwiązane z zadaniem

- `data/delegations.json` (30 MB, 1041 pozycji) + `delegation-mailbox.json` (10 MB) —
  prawdopodobna przyczyna zamrożenia persystencji; patrz todo R17/R18.
- Równoległe cykle (maxParallel=3) + scouty konkurują o jeden workspace'owy slot
  mutacji; start implement/fix często kończy się `CONFLICT` i wymaga czekania.
- Czat `c84b5a31-…` (używany w pierwotnym harnessie) został zarchiwizowany w trakcie
  cyklu — harness wybiera teraz niearchiwalny, np. `fabd16a3-8e28-4ccc-a991-671664916696`.
