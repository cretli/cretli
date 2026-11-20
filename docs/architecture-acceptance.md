# Odbiór architektury (etap 8) — stan faktyczny

Dokument towarzyszący: [architecture-acceptance.json](architecture-acceptance.json) (wersja maszynowa, walidowana
przez `tests/architecture-acceptance.test.js`). Baza materiału: HEAD `08c9699` gałęzi worktree programu 7ec86917 (etapy 1–6 w commitach checkpointów; pliki etapów 7 i 8 są **niezatrackowane**, bez checkpointu).

**Werdykt ogólny: NOT ACCEPTED.** To jest dokument stanu, nie deklaracja ukończenia. Żaden pion V0–V10 nie ma
`completionAllowed=true` w [macierzy gotowości](architecture-readiness-matrix.json), a kryteria wymagające
prawdziwej przeglądarki/urządzenia, testu mieszanego ≥10 min i stabilności po 20 cyklach nie zostały wykonane.

Werdykty: ACCEPTED / NOT ACCEPTED / BLOCKED / NOT MEASURED. Pion zablokowany przez inny program jest raportowany
jako BLOCKED, nigdy jako zrobiony (DAG §4).

## 1. Plan odbioru — piony

| Pion | Nazwa | Werdykt | Powód |
| --- | --- | --- | --- |
| V0 | Request-local indeks czatów | NOT ACCEPTED | niezacommitowany w głównym checkoucie; commit wymaga jawnego polecenia |
| V1 | Read model katalogu czatów | NOT ACCEPTED | zero-copy na poziomie store wymaga A2/A3b |
| V2 | DTO / sync listy sidebara | NOT ACCEPTED | brak realnej przeglądarki; R13 (statusy recovery) i A3a (historia) brakują |
| V3 | Historia / search / replay | BLOCKED (odroczony) | A2, A3a |
| V4 | Wspólny model encji frontu | NOT ACCEPTED | eksperymentalny model encji usunięty; następca wymaga nowego kontraktu i odbioru desktop/mobile |
| V5 | TODO / Watcher / delegacje, tick | BLOCKED (odroczony) | A4, A3b, R14–R20; tick czyta cały mailbox |
| V6 | Prymitywy blokujące | NOT ACCEPTED | `Atomics.wait` należące do storage, sondowanie owner-lock, katalog 20000 wpisów |
| V7 | Boot / nawigacja / Settings | NOT MEASURED | brak bazy cold/warm/offline; zmierzono tylko `GET /api/settings` po stronie serwera |
| V8 | Files / Terminal / Browser | NOT MEASURED | narzut Cretli zmierzony syntetycznie; realny shell i Chromium nie |
| V9 | Obserwowalność i fixtury | NOT ACCEPTED | fixtury i smoke są; brak testu ≥10 min i 20 cykli |
| V10 | Migracja i multi-instance | BLOCKED (odroczony) | cutover każdego store zablokowany (A3a/A3b/A4/A5/A6/B4); zestaw regresji multi-instance przechodzi |

Źródła: macierz gotowości, [DAG pionów](architecture-vertical-dag.md), manifest
[architecture-manifest-stage7.json](architecture-manifest-stage7.json) (manifest planu v6 jest nieaktualny do czasu zatwierdzenia planu v7 przez człowieka; manifest etapu 7 jest generowany `node scripts/architecture-manifest-stage7.mjs --write docs/architecture-manifest-stage7.json` PO ostatniej edycji dokumentów, a test przelicza SHA-256 i bajty każdego wpisu).

## 2. Ponowne uruchomienia w tym środowisku

Środowisko: Node v24, Linux (WSL2), jedna maszyna, dane syntetyczne (seed 20261017). Wszystkie P99 z n=200 są
**exploratory**; stabilne tylko z n≥1000. Przebiegi nie wymagają prawdziwej przeglądarki, więc nie zastępują odbioru UI.

### 2.1 HTTP (`architecture-http-bench.mjs`, 500/5000/20000, n=200)

Porównanie z zapisanym `architecture-http-baseline.json`: to ten sam kod (commit 08c9699), więc jest to
**powtórzenie, nie before/after zmiany**; różnice w granicach szumu (np. 20000 `pageFirst` P99 11.485 vs 12.109 ms).
Brak bazy sprzed etapów 1–6 („no baseline”). Powtórzenie z `--out` do katalogu tymczasowego poza repo: Node v24.14.0, Linux WSL2, jedna maszyna, te same fixtury; **surowe wyjścia nie są zapisane w repo**, więc liczby są niezależnie nieweryfikowalne (JSON: `measurements.rerun`).

| Endpoint (n=200) | Rozmiar | Bajty | P50 | P95 | P99 | max (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/chats` (legacy) | 500 | 157157 | 0.932 | 1.232 | 1.353 | 5.849 |
| `GET /api/chats` (legacy) | 5000 | 1499938 | 6.248 | 9.505 | 11.814 | 13.248 |
| `GET /api/chats` (legacy) | 20000 | 5372215 | 23.783 | 34.174 | 35.089 | 35.667 |
| `GET /api/chats?includeArchived=1` | 20000 | 7594586 | 26.988 | 37.041 | 40.175 | 45.159 |
| `GET /api/chats/page?limit=100` | 500 | 38174 | 0.358 | 0.527 | 0.708 | 0.74 |
| `GET /api/chats/page?limit=100` | 5000 | 38243 | 1.485 | 2.125 | 3.823 | 5.963 |
| `GET /api/chats/page?limit=100` | 20000 | 38262 | 6.829 | 11.087 | 11.485 | 15.059 |
| `GET /api/settings` | 20000 | 6570 | 0.447 | 0.577 | 0.755 | 1.264 |

Limity zamrożone: strona API ≤100 wierszy / ≤128 KiB — **spełnione tylko dla domyślnej strony `limit=100`** (≈37 KiB); `lib/chat-catalog.js` obcina `limit` do 500 (`CHAT_CATALOG_PAGE_MAX_LIMIT`), więc strona `limit=500` (~190 KB / 500 wierszy) limit przekracza — egzekwowanie pozostaje OTWARTE (właściciel V1, osobny todo). Odpowiedź ≤1 MiB — **niespełnione**
dla nieostronicowanego `GET /api/chats` od 5000 czatów (1.43 MiB; 5.1 MiB przy 20000).

### 2.2 Lista czatów (`architecture-chat-list-bench.mjs`), 20000 czatów

| Pomiar | n | P50 | P95 | P99 | max (ms) |
| --- | --- | --- | --- | --- | --- |
| loadWarm | 1000 | 0.446 | 0.592 | 1.849 | 3.977 |
| loadCold | 30 | 10.672 | 16.169 | — | 16.268 |
| scopeLegacy (50 lookupów/request) | 30 | 29.248 | 32.618 | — | 34.377 |
| scopeIndexed | 1000 | 1.717 | 2.402 | 4.54 | 5.63 |

Dla scopeLegacy → scopeIndexed jest para before/after na tych samych danych (P50 29.2 → 1.7 ms); n=30 po stronie
legacy, więc to wartość orientacyjna. Liczba 12.85 s → 279 ms z planu **nie** została odtworzona.

### 2.3 Profil zatrzymań pętli zdarzeń (`architecture-stall-profile.mjs`, rozdzielczość 1 ms)

- W granicach: rejestry bez rywalizacji (P99 call ≤0.6 ms), `loadChats` copy (n=1000, P99 0.569 ms, event-loop max 2.152 ms),
  tick runtime pełny (n=100, P99 17.5 ms), lista plików do 5000 wpisów, odczyt 1 MiB, PTY/Browser (syntetyczne).
- Poza budżetem (exploratory, n=20–200): rywalizowane locki rejestrów ≈53 ms, sondowanie owner-lock ≈81 ms,
  lista katalogu 20000 wpisów: P99 wywołania 45.4 ms, event-loop P99 46.0 / max 51.6 ms (bramka aplikacji <100 ms spełniona,
  ostrzejsza bramka storage P99 ≤25 ms nie).
- `AW-usage-ledger-uncontended`: event-loop max 42.2 ms, P99 13.2 ms (n=1000) — w bramce storage (P99 13.2 ms < 25 ms). Powtórzenie dało max 18.7 ms / P99 14.7 ms (n=1000): rozrzut między przebiegami, bez surowych wyjść.
- NOT MEASURED w profilu: opóźnienia sqlite-busy/lock-backoff watcherów, część subprocesów (`SC-*`), realny shell i start Chromium.

### 2.5 Testy

- `scripts/architecture-multi-instance-regression.mjs`: **18/18 plików przeszło**.
- Testy kontraktowe etapów 2–6 (16 plików: chat-catalog-contract/pagination, architecture-http-fixture,
  architecture-stall-profile, chat-list-sync, chat-list-sync-client, chat-list-live-sync-delta, delegation-route-chat-index,
  sidebar-render-metrics, ui-freeze-trace, files-list, pty-broadcast, browser-session-manager, todo-list-performance,
  chat-perf-budget, multi-instance-regression): wszystkie 0 fail.
- Lista „16 plików” obejmuje także testy etapu 7 (np. multi-instance-regression); nazwy są podane dosłownie powyżej.
- Nie uruchomiono pełnego `npm test` ani testów e2e Playwright.

## 3. Lista NOT ACCEPTED (z powodami)

| Kryterium | Werdykt | Powód |
| --- | --- | --- |
| Desktop/mobile cold/warm/offline/reconnect/multi-tab | NOT MEASURED | brak prawdziwej przeglądarki/urządzenia |
| ≥50 prób interakcji, P99 z ≥1000 próbek (UI) | NOT MEASURED | j.w.; serwerowe n=200 to exploratory |
| Test mieszany ≥10 min (3–5 streamów + Watcher + bursty) | NOT MEASURED | nie uruchomiony |
| Stabilność pamięci/listenerów/timerów/subprocesów po 20 cyklach | NOT MEASURED | nie uruchomiona |
| DOM ≤5000 węzłów / ≤300 wierszy | NOT MEASURED | liczba wierszy w modelu OK, DOM wymaga przeglądarki |
| Strona API: limit do 500 (clamp katalogu) | NOT ACCEPTED | egzekwowanie limitu strony otwarte (V1) |
| Odpowiedź ≤1 MiB dla `GET /api/chats` | NOT ACCEPTED | 1.43 MiB przy 5000, 5.1 MiB przy 20000 czatów |
| Event-loop P99/max: aplikacja i storage | NOT ACCEPTED | brak przebiegu całej aplikacji; pojedyncze miejsca poza budżetem (pkt 2.4) |
| Katalog 20000 wpisów (P99 ≈46 ms) | NOT ACCEPTED | wymaga asynchronicznego/chunkowanego listowania |
| Tick runtime czyta cały mailbox | BLOCKED | A4 + R15; liniowy wzrost to ekstrapolacja |
| `loadChatsSnapshot` kopiuje listę (wzrost z N) | BLOCKED | A2 (storage) |
| Crash/retry/cancel/restore, durable ACK (C12, odroczone) | BLOCKED | A3a i R-items niezintegrowane |
| C3a: latencja strony serwera P95 ≤100 ms | ACCEPTED (tylko P95) | P95 11.087 ms; P99 ≤250 ms NOT MEASURED (n=200 <1000) |
| C3b: before/after latencji strony na identycznych danych | NOT MEASURED | brak bazy sprzed zmiany |
| C15: granice domen, źródła prawdy, wycofane duplikaty, cleanup | NOT ACCEPTED | legacy `GET /api/chats` + `chatListLiveSync` remain beside `/api/chats/page` + the unwired `chatListSyncClient`; the established sidebar renderer remains active |
| C16: stały perf smoke i obserwowalność bez sekretów | NOT ACCEPTED | `health-routes.js` próbkuje pętlę co 20 ms vs kontrakt V9 1 ms; brak kontroli sekretów |
| C17: wiek kolejki persist (P95 ≤200 ms, burst ≤2000 ms) | NOT MEASURED | brak pomiaru |
| C18: testy scope (durable ACK/crash/restore/scope) | NOT MEASURED | stage testy pokrywają tylko lease/refusal/failover/stub i scope katalogu |
| C19: lista wymagane vs odroczone | ACCEPTED | V3/V5/V10 i C12 odroczone (blocked), reszta wymagana; egzekwuje test |
| Elementy zablokowane przez A2–A6, B4, R13–R20 | BLOCKED | własność storage/recovery; bez zmiany kontraktów |
| Artefakty etapów 1–6 tylko w checkpointach; pliki etapów 7 i 8 niezatrackowane (bez checkpointu) | NOT ACCEPTED | test zależy od niezatrackowanej `architecture-readiness-matrix.json`, więc etap 8 nie zintegruje się samodzielnie |
| Fix indeksu request-local i zmiana mcp-vendor-map niezacommitowane w głównym checkoucie | NOT ACCEPTED | czeka na polecenie użytkownika |
| Manifest planu v6 (C14) | NOT ACCEPTED | nieaktualny do zatwierdzenia planu v7; manifest etapu 7 generowany po ostatniej edycji |
| Multi-instance regresja (C10) | ACCEPTED (kwalifikowane) | 18/18 na atrapie Redis w pamięci; recenzje etapów 5/7 oczekują; luki poniżej |
| Strona API ≤100 wierszy / ≤128 KiB (C1, tylko domyślna strona) | ACCEPTED (kwalifikowane) | ≈37 KiB przy `limit=100` (fixture syntetyczny) |
| Testy kontraktowe etapów 2–6 (C11) | ACCEPTED (kwalifikowane) | 0 fail; recenzja etapu 2 nieznana, etapów 5 i 7 oczekują |

## 4. Otwarte pozycje przeniesione

- Recenzje: etap 2 nieznany, etapy 5 i 7 oczekują (C10/C11 ACCEPTED tylko na tym materiale).
- Luki multi-instance (obok C10): tylko atrapa Redis w pamięci, brak testu błędu WS stuba, limit replay nieprzetestowany,
  Redis pub-sub nieprzetestowany, trwałość ownera tylko zadeklarowana (follow-up todo af2d01d2).
- V7: ryzyko `sw.js` network-first z timeoutem 3 s; sondowanie owner-lock nigdy nie raportuje żywego gniazda (R3).
- Todo follow-up: 0185d51d, 41b8179c, 9c45b1f5, 70438662, c4ca43f3, af2d01d2.

Wniosek: nie można ogłosić pełnego odbioru. Otwarte pozostaje wszystko w tabeli oznaczone innym werdyktem niż ACCEPTED.
