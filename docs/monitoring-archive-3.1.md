# Monitoring — raport przyczyn przed/po i bramka archiwum (3.1)

Data: 2026-10-06. Zakres: liść **3.1 „Zmierzyć przyczyny monitoringu i
ograniczyć archiwum"** etapu 3 planu UI-freeze. Dokumentuje pomiar przyczyn
kwalifikacji do monitoringu na realnym zbiorze oraz zmianę polityki: archiwalny
czat kwalifikuje się wyłącznie gdy jest aktywny albo ma faktyczny run.

Powiązania:

- instrumentacja bazowa: `docs/ui-freeze-baseline-2026-10-05.md`
  (`monitoring:<reason>|archived=<bool>`),
- kod: `app_front/features/chat/chatBackgroundPolicy.js`,
  `app_front/features/chat/chatStatusMeta.js`,
  `app_front/lib/uiFreezeCounters.js`,
  `app_front/features/chat/chatHistorySyncPoll.js`,
- pomiar: `node scripts/measure-monitoring-archive-baseline.mjs`,
- testy: `tests/monitoring-archive-qualification.test.js`.

## Metoda

„Przed" = `classifyMonitoringCandidateReasons` — dokładnie dawne warunki
(bez bramki archiwum). „Po" = `classifyMonitoringReasons` +
`selectMonitoredChatIds` — warunki po zmianie 3.1. Licznik
`monitoringCandidate:<reason>|archived=<bool>` zbiera stronę „przed", a
`monitoring:<reason>|archived=<bool>` stronę „po"; różnica to liczba
kwalifikacji usuniętych przez bramkę. Liczby są **przyczynami** (czat może
pasować do kilku), nie liczbą czatów.

Realny zbiór: `data/chats.json` (1382 czaty, 1167 archiwalnych) plus żywa mapa
`summarizeChatRunStates()` — dokładnie to, co zwraca globalne
`GET /api/chats/agent-states`. To ta sama ścieżka, która nadała czatom stan
`waiting`/`attention`.

## Hipoteza: globalny agent-states nadaje nieaktywne waiting/attention

**Potwierdzona na realnych danych.** Mapa agent-states zwróciła 838 nie-idle
wpisów: **836 `attention`**, 1 `waiting`, 1 `busy`. `attention` w
`lib/agent-run-state.js` oznacza *zakończoną, niezaakceptowaną delegację*
(`TERMINAL_ATTENTION`), a `waiting` — delegację czekającą na wejście użytkownika.
Żadne z nich nie jest trwającym runem, a dawne `selectMonitoredChatIds`
kwalifikowało po samym `chat._serverRunState?.state`.

## Raport przyczyn przed/po — realny zbiór

`node scripts/measure-monitoring-archive-baseline.mjs` (2026-10-06,
Node v22.23.2, aktywny czat `2b303f8e…`):

| przyczyna | archived | przed | po | usunięte |
| --- | --- | ---: | ---: | ---: |
| active | false | 1 | 1 | 0 |
| recent | false | 5 | 5 | 0 |
| live | false | 2 | 2 | 0 |
| busy | false | 1 | 1 | 0 |
| waiting | false | 1 | 1 | 0 |
| attention | true | 768 | 0 | **768** |
| attention | false | 68 | 68 | 0 |
| **razem** | — | **846** | **78** | **768** |

Zbiór monitorowanych czatów: **838 → 70**. Cała różnica (768) to archiwalne
czaty trzymane wyłącznie przez zaległe `attention` zakończonych delegacji. Nie
był to run ani otwarty czat — bramka 3.1 je usuwa.

## Raport przyczyn przed/po — kształt regresji 1500/1200

Ten sam skrypt, zbiór syntetyczny 1500 czatów / 1200 archiwalnych (jawnie
oznaczony jako syntetyczny odpowiednik, gdy realny plik jest niedostępny):

| przyczyna | archived | przed | po | usunięte |
| --- | --- | ---: | ---: | ---: |
| active | false | 1 | 1 | 0 |
| recent | true | 240 | 0 | 240 |
| recent | false | 60 | 60 | 0 |
| live | true | 402 | 3 | 399 |
| live | false | 100 | 100 | 0 |
| waiting | true | 400 | 0 | 400 |
| waiting | false | 100 | 100 | 0 |
| attention | true | 400 | 0 | 400 |
| attention | false | 100 | 100 | 0 |
| **razem** | — | **1803** | **364** | **1439** |

Wartość **402** dla `live|archived=true` (przed) to 400 wierszy z
`index % 3 === 0` (`waiting`) plus **syn-500** i **syn-1000** z
`_sdkServerBusy` poza tym modułem — zgodnie z `buildSyntheticChats` w
`scripts/measure-monitoring-archive-baseline.mjs`.

Monitorowane czaty: **1100 → 223**. Po stronie archiwalnej zostają wyłącznie
rzeczywiste runy (`live` z `_sdkServerBusy`). Niearchiwalne `waiting`/
`attention`/`recent` zachowują dotychczasowe zachowanie.

## Zmiana polityki

- `isArchivedChat(chat)` = niepusty `archivedAt`.
- `qualifiesArchivedMonitoring(chat, activeChatId)` — niearchiwalny: zawsze
  `true`; archiwalny: tylko aktywny czat albo `hasConfirmedAgentRun(chat)`.
- `classifyMonitoringReasons` — dla archiwalnego czatu przepuszcza wyłącznie
  powody `active`, `live`, `busy`; `recent`/`waiting`/`attention` same nie
  kwalifikują.
- Ta sama bramka jest w szybkiej ścieżce `selectMonitoredChatIds`, w
  `selectHistoryHttpChatIds` (defence in depth przed widocznością z otwartego
  archiwum) oraz w `selectBackgroundWsChatIds` (archiwalny czat nie zajmuje
  slotu WS przez `recent`/`waiting`).

### Kontrakt run — uzupełnienie

`hasActiveAgentRun` = `_agentState === 'active' || hasProtocolAgentRun` nie
wystarcza, bo `_agentState` jest podtrzymywane przez
`hasKeepAliveHarnessWork` (m.in. `waiting` i pending question/permission).
Dodano `hasConfirmedAgentRun`: run potwierdzony protokołem (busy/kolejka) zawsze
wygrywa; rodzic ze stanem `waiting` i aktywnymi delegacjami dzieci
(`waitingAgentCount` albo `delegationStatus` in-flight:
`queued|starting|running|cancelling`) też. Lokalny `_agentState` liczy się tylko,
gdy nie ma jawnej nie-runowej presence (stale `waiting`/`attention`/pending).
Bramka archiwum używa tego predykatu, więc sam nie-idle stan nie jest
utożsamiany z pracą.

## Otwarcie archiwum

`collectRenderableChatIds` (`app_front/features/sidebar/sidebarView.js:1455`)
dodaje wszystkie archiwalne id, gdy sekcja archiwum jest otwarta. Ponieważ
zaległe archiwalne czaty nie są już w `monitoredChatIds`, a
`selectHistoryHttpChatIds` dodatkowo stosuje bramkę, otwarcie archiwum **nie
rozszerza** HTTP-pollingu zaległych stanów. Aktywny czat i rzeczywiste runy
(na żywo, także poza viewportem) pozostają monitorowane.

## Presence

`chatExpectsLiveSocket` (`app_front/chat.js`) pyta bramkę 3.1: archiwalny czat
bez faktycznego runu nie oczekuje socketu. W sidebarze `resolveHarnessChatStateMeta`
(`surface: 'sidebar'`, `socketExpected: false`) mapuje zaległe `waiting`/
`attention` bez in-flight child jobs na `idle` („Ready"), a nie
`disconnected` ani „Needs action". Rodzic z `waitingAgentCount` nadal pokazuje
`awaiting`. Ścieżka samej presence (`applyAgentStatesToChats` /
`agentPresenceStore`) pozostaje nietknięta — zmienia się tylko meta wiersza i
oczekiwanie socketu.

## Weryfikacja

```
node tests/monitoring-archive-qualification.test.js   # 11+ (regression incl. child jobs)
node tests/chat-background-policy.test.js             # ok
node tests/ui-freeze-counters.test.js                 # ok
node tests/chat-list-sort.test.js                     # ok
node tests/chat-status-meta.test.js                   # ok
node tests/chat-delete-confirm.test.js                # ok
node scripts/measure-monitoring-archive-baseline.mjs  # raport powyżej
```
