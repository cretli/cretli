# Plan: stopniowe przejście na TypeScript + core harnessy (Claude, Cursor, Codex)

Status: **szkic** (2026-10-21). Nic tu nie startuje pracy bez akceptacji człowieka.
Uzupełnia, a nie zastępuje, program architektury
[ADR-0001](architecture-target-adr.md) / [vertical DAG](architecture-vertical-dag.md).

## 0. Stan wyjściowy (zmierzony)

| Fakt | Wartość |
| --- | --- |
| Kod JS (lib + app_front + server.js) | ~431 tys. linii |
| Pliki z JSDoc (`@param` / `@typedef`) | 1177 |
| Pliki z `// @ts-check` | 0 |
| `tsconfig.json` / `jsconfig.json` | brak |
| TypeScript w `node_modules` | 7.0.2 (natywny kompilator) |
| `engines.node` / CI | `>=22.16` / Node 22 |
| Front | webpack 5, lit, ESM |
| Transporty (`lib/agent-transport.js`) | 11: `sdk`(Cursor), `claude`, `codex`, `openrouter`, `mistral`, `zai`, `mimo`, `opencode`, `codebuddy`, `deepseek`, `qwen` |
| Twarde gałęzie `=== '<transport nie-core>'` | ~276 |
| Pliki spoza katalogu harnessu, które go nazywają | 58–127 na harness |
| Kontrakt i loader pluginów harnessów | są (`harness-plugin-contract.js`, `harness-plugin-loader.js`), **nie są podpięte** |

Wniosek: projekt jest już „pół-otypowany” przez JSDoc. Najtańsza droga to
najpierw `checkJs` (zero zmian w runtime), a `.ts` dopiero tam, gdzie się opłaca.

## 1. Decyzje

- **D1. Core = `claude`, `sdk` (Cursor), `codex`.** Pozostałe 8 transportów
  przechodzi do statusu *optional plugin*: nie znikają od razu, ale rdzeń
  przestaje je znać po nazwie.
- **D2. OpenRouter dzielimy na dwie części.** Klient OpenRouter jest
  infrastrukturą: używają go `model-pick-*`, `chat-title-*`, cost proxy i usage.
  Zostaje w rdzeniu jako `lib/providers/openrouter`. Do pluginów idzie tylko
  harness czatu OpenRouter (`openrouter-agent-ws`, `openrouter-agent-loop`).
- **D3. TS bez kroku build na serwerze.** Węzeł ≥ 22.18 usuwa typy natywnie.
  Używamy tylko składni wymazywalnej (`erasableSyntaxOnly`): bez `enum`,
  `namespace`, parameter properties i dekoratorów. Importy z rozszerzeniem `.ts`.
- **D4. Front: TS przez loader w webpacku** (`esbuild-loader`, tylko transpilacja);
  typecheck robi osobno `tsc --noEmit`. Lit bez dekoratorów (`static properties`).
- **D5. Ratchet, nie big-bang.** CI blokuje *wzrost* liczby błędów typów, a nie
  ich istnienie. Bez masowych rename'ów plików objętych aktywnymi verticalami
  ADR-0001 (V1, V4, V5): tam tylko `@ts-check` i JSDoc.

## 2. Ścieżka A — TypeScript

**A0. Fundament (bez zmian w runtime)** — *zrobione 2026-10-21*
- `tsconfig.base.json` + `tsconfig.json` (serwer: `server.js`, `lib`, `scripts`) +
  `app_front/tsconfig.json` (DOM, `moduleResolution: bundler`): `allowJs`,
  **`checkJs: true`** (zamiast `false`: istniejący JSDoc od razu coś daje, a ratchet
  trzyma poziom), `noEmit`, `erasableSyntaxOnly`, `allowImportingTsExtensions`,
  `strict: false`.
- `scripts/typecheck-ratchet.mjs`: `npm run typecheck` liczy błędy per plik
  i failuje, gdy któryś plik ma ich więcej niż w `docs/typecheck-baseline.json`.
  Mniej błędów przechodzi z podpowiedzią. `npm run typecheck:baseline` przepisuje
  baseline, świadomie i z uzasadnieniem w PR. Błędy bez pliku (zły tsconfig) zawsze failują.
- Krok „Typecheck (ratchet)” w `ci.yml` po lint. `typescript@7.0.2` i
  `@types/node@22.20.5` przypięte w devDependencies (wcześniej były tylko
  przechodnie: TS z lexical, `@types/node@25` z protobufjs).
- Baseline: serwer **17 609 błędów w 605 plikach**, front **7 685 w 333**.
  Około 90% to TS2339 (właściwość na `object`/`HTMLElement`), czyli efekt
  luźnych `@param {object}`. Pełne sprawdzenie trwa około 1 s na projekt.
- Poprawka przy okazji: komentarz `//` wewnątrz typu JSDoc w
  `lib/chat-run-service.js` był błędem składni TS i wyłączał sprawdzanie całego serwera.
- `@types/ws` i podbicie `engines.node` do `>=22.18` **przeniesione do A2**:
  nie ma jeszcze plików `.ts`, więc w A0 nic tego nie wymaga.

**A1. Poziom strict dla kontraktów** (kolejność wg wartości):

Od A0 `checkJs` jest włączony globalnie, więc `// @ts-check` niczego nie dodaje.
A1 to więc **poziom strict**: `tsconfig.strict.json` (`strict: true`) z jawną listą
`files`. Ratchet wymaga tam **0 błędów** bez baseline'u (`--update` go nie poluzuje)
i liczy tylko pliki z listy. Kolejne kontrakty wchodzą przez dopisanie ich do `files`.

1. *zrobione 2026-10-21*: `agent-transport.js`, `agent-harness/types.ts`,
   `harness-plugin-contract.js`, `registry.js`.
   - `AgentTransport` jest wyprowadzony z jednej krotki w `agent-transport.js`.
     Duplikat unii w `types.js` jest teraz re-eksportem. `VALID_TRANSPORTS`
     zostaje na zewnątrz typu `readonly string[]`, żeby `.includes(string)`
     u wywołujących dalej się typował.
   - Nowe: `CORE_AGENT_TRANSPORTS` (`claude`, `sdk`, `codex`), typ
     `CoreAgentTransport` i guard `isCoreAgentTransport` (dokładne dopasowanie,
     bez fallbacku do `sdk`). Test: `tests/agent-transport-core.test.js`.
   - Kontrakt pluginów: `ContractFailure` (`ok: false`, wymagane `code`/`error`)
     zamiast luźnego `ContractResult`. 12 ręcznych bloków `err.code/err.field`
     zastąpił helper `manifestError`. Zachowanie się nie zmienia (30/30 testów kontraktu).
   - Efekt uboczny: serwer ma 17 557 błędów (było 17 609). W projekcie
     nie-strict kontrakt ma jeszcze 5 błędów, bo bez `strictNullChecks`
     `if (!result.ok)` nie zawęża unii. Rozstrzygający jest poziom strict.
   - FU-2 (dlaczego pliki strict-clean liczą błędy w luźnym baseline): ten sam plik
     jest sprawdzany dwa razy. `tsconfig.strict.json` ma `strictNullChecks`, więc unie
     dyskryminowane (`{ ok: true } | { ok: false; reason }`) zawężają się po `ok`.
     `tsconfig.json` go nie ma, więc `result.reason` daje TS2339. Dotyczy to dziś
     `lib/approval/approval-advisor.ts` (6) i `lib/notifications/memory-monitor-producer.ts` (1)
     w `docs/typecheck-baseline.json`. To artefakt luźnej konfiguracji, nie błąd w kodzie;
     bramką jest strict (0 błędów), a wpisy znikną z luźnego baseline przy włączeniu
     `strictNullChecks` dla całego serwera.
2. warstwa `lib/persist/*` (kształty rekordów todo, chat, delegacji) — *zrobione 2026-10-22*:
   - Nowy plik typedef `lib/shared-types/persist-records.js` (`TodoRecord`, `ChatRecord`,
     `DelegationRecord`, `DelegationOutboxItem`) — rekordy są otwarte (`[key: string]: unknown`).
   - W strict: `persist-records.js`, `persist/delegation-schema.js`, `delegation-index-fields.js`,
     `delegation-store-backend.js`, `atomic-write.js`.
   - **Poza strict** (dostają tylko typedefy, bez zmian runtime): `persist/todos-persist.js`
     (255 błędów strict), `chats-persist.js` (245), `delegations-persist.js` (218). To 1000–1800 linii
     z luźnymi `@param {object}`; doprowadzenie do 0 wymaga dużego przepisania JSDoc, więc zostają
     na kolejny krok (rekordy opisuje już `persist-records.js`).
3. `delegation-*.js`, `workspace-watcher*.js`: typedefy + JSDoc, bez rename (V5) — *zrobione 2026-10-22*:
   - W strict: `delegation-assignment`, `-command`, `-lifecycle`, `-rating-constants`,
     `-workspace-key`, `-review-subject`, `-request`, `-source`, `-verdict`, `-failure-class`,
     `-work-role`, `workspace-watcher-blocked-reason`.
   - Poza strict (≥ 6 błędów strict): m.in. `delegation-status` (9), `-width` (6), `-health` (20),
     `-attempt` (58), `workspace-watcher-pinned-chat` (18), `-stats` (62) oraz reszta rodziny;
     `delegation-service.js` i `workspace-watcher*.js` mają dziesiątki–setki błędów.
4. `lib/ws/*`, protokół WebSocket współdzielony z frontem → `lib/shared-types/` — *zrobione 2026-10-22*:
   - Nowy plik typedef `lib/shared-types/ws-protocol.js` (`WsServerMessage`, `WsClientMessage` i
     składowe kanału terminal/task/build).
   - W strict: `ws-protocol.js`, `ws/ws-path.js`, `ws/ws-auth-boundary.js`, `ws/ws-origin.js`.
   - Poza strict: `ws-keepalive`, `ws-session-registry`, `front-build-ws`, `server-log-ws`
     (wymagają `@types/ws`, przesunięte do A2), `ws-router` (25), `task-ws-handler` (17),
     `pty-ws-handler` (91). The legacy agent runner was subsequently removed.
   - Poziom strict liczy teraz 38 plików (było 17), 0 błędów. Baseline (nie-strict): serwer
     17 290 błędów (było 17 312), front 7 516 (było 7 524) — stan w drzewie roboczym przed i po.

**A2. Pierwsze pliki `.ts`** — *zrobione*: `engines.node >=22.18` (+ `.nvmrc`, Dockerfile, CI,
skrypty startowe, sprawdzenie w `run-unit-tests.mjs`), `@types/ws`, `lib/model-facts` (część),
`lib/usage`, `lib/credit-ledger` w `.ts`, `lib/shared-types/*.ts`, reguła w `CONTRIBUTING.md`.
Moduły osiągalne z frontu zostają `.js` do A4 (brak loadera TS w webpacku).
- Nowe pliki od razu w `.ts` (reguła w `CONTRIBUTING.md` + lint).
- Konwersja liści bez zależnych: `lib/model-facts`, `lib/usage`, `lib/credit-ledger`.
- Wspólne typy domenowe (`Todo`, `Chat`, `Delegation`, `WatcherCycle`, `HarnessEvent`)
  w `lib/shared-types/*.ts`, importowane też przez `app_front`.

**A3. Core harnessy w TS** (po ścieżce B3, żeby nie migrować kodu, który zaraz wyjdzie)
- `lib/agent-harness/*` → `lib/claude/*` → `lib/codex/*` → `lib/sdk/*` (Cursor).
- `strict: true` per katalog (`tsconfig` z `include` zawężonym do przekonwertowanych katalogów).
- Podział na liście: A3-codex / A3-claude / A3-agent-harness / A3-sdk.
  - **A3-codex — zrobione 2026-10-22:** wszystkie `lib/codex/*.js` → `.ts` (`git mv`, składnia
    wymazywalna, importy z `.ts`); pliki dopisane do `tsconfig.strict.json` (warstwa strict,
    0 błędów, bez baseline); baseline serwera tylko spadł (wpisy `lib/codex/*.js` usunięte).
  - **A3-claude — zrobione 2026-10-22:** wszystkie 11 plików `lib/claude/*.js` → `.ts` (`git mv`,
    składnia wymazywalna, importy z `.ts` w lib/tests/docs); dopisane do `tsconfig.strict.json`
    (79 plików strict, 0 błędów); baseline serwera tylko spadł (15930, wpisy `lib/claude/*.js`
    usunięte). Typy SDK nie są importowalne (pakiet opcjonalny), więc `ClaudeSdkModule` jest
    strukturalny, a `ClaudeRoom`/`ClaudeSession`/`ClaudeQuery` w `claude-agent-ws.ts` to `any`
    (luźne obiekty pokoju/sesji/Query) — do zawężenia przy A3-agent-harness.
  - **A3-agent-harness — zrobione 2026-10-22:** wszystkie 36 plików `lib/agent-harness/*.js` → `.ts`
    (`git mv`, składnia wymazywalna, typedefy JSDoc → eksportowane typy/interfejsy, importy `.ts`
    w lib/harnesses/app_front/tests/docs); 109 plików w `tsconfig.strict.json`, 0 błędów; baseline
    serwera tylko spadł (15792), front bez zmian (7502). Pokoje (`Room`) w `room-kernel.ts`
    i kolejce promptów zostają `any` (jak w `lib/claude`/`lib/codex`).
  - **A3-sdk — zrobione 2026-10-22:** wszystkie 59 plików `lib/sdk/*.js` → `.ts` (`git mv`, składnia
    wymazywalna, importerzy w lib/harnesses/scripts/tests/app_front na `.ts`), wszystkie w
    `tsconfig.strict.json` (strict: 168 plików, 0 błędów; serwer 15792 → 15521, front 7502 → 7430).
    Moduły współdzielone z frontem (`sdk-mode`, `sdk-chat-history`, `sdk-context-advisory`, …) bez importów
    Node. Pokoje (`room`) nadal `any` tam, gdzie JSDoc już mówił `any` (brak wspólnego typu pokoju).
    Jedyna zmiana zachowania: `sdk-review-lint` akceptuje też pliki `.ts/.mts/.cts` (inaczej reviewerzy
    nie zlintują zmigrowanych plików). Rozmiary bundli prod bez zmian (index 2377234 → 2377120 B).

**A4. Front** — *loader zrobiony 2026-10-22; konwersja per feature trwa*
- `esbuild-loader` (devDependency `cretli-front`) w `app_front/webpack.dev.js` i
  `webpack.prod.js` dla `.ts` (tylko transpilacja, `target: es2022`; typy sprawdza
  `npm run typecheck`); `resolve.extensions: ['.js', '.ts']`. Reszta `.js` bez zmian
  (nie przechodzi przez esbuild). Test-owy `tests/sidebar-workspace-dom/webpack.config.js` ma tę
  samą regułę. `webpack.widget.dev.js` jeszcze bez reguły `.ts` (widget nie sięga `.ts`).
- Wzorzec: `app_front/features/sidebar/cr-sidebar-subchat-group.ts` (Lit, `static properties`
  bez dekoratorów, pola przez `declare`, składnia wymazywalna). Importy używają jawnego `.ts`.
- Rozmiary bundli (prod): `index.bundle.js` 2 352 914 → 2 352 918 B, pozostałe główne bundle bez zmian.
- Następny krok: 7 modułów z A2 zostawionych w `.js` (`lib/usage/{usage-contract,usage-event,
  usage-normalize,usage-rates}.js`, `lib/model-facts/{identity,schema,telemetry}.js`) może przejść
  na `.ts` w osobnym kroku (webpack już je obsłuży; wymaga zmiany specyfikatorów importów
  na `.ts` po stronie serwera, frontu i testów).
- `@ts-check` na `api.js` i `features/*`; konwersja per feature.
- `chat.js` (11k linii) **nie** w tej ścieżce: dzieli go V4 z ADR-0001,
  a TS wchodzi w już wydzielone moduły.

**A5. Zaostrzanie**
- `strict` globalnie, gdy baseline ≈ 0 w `lib/`; potem `noUncheckedIndexedAccess`.

## 3. Ścieżka B — redukcja do core harnessów

**B1. Inwentaryzacja** — *zrobione 2026-10-21*
- `npm run inventory:harness-coupling` (`scripts/harness-coupling-inventory.mjs`)
  zapisuje `docs/harness-coupling-inventory.json`. Pliki *własne* harnessu
  (`lib/<id>/` albo id w nazwie pliku) przenoszą się z nim. Każde odwołanie
  w pliku *współdzielonym* to sprzężenie dla B2. Rodzaje odwołań: import, branch,
  key, literal, identifier, comment. Obszary: settings_ui, auth, models,
  usage_pricing, i18n, tests, capability. Klasyfikacja jest heurystyką na poziomie
  linii, co wystarcza do oszacowania i ułożenia pracy.

Wyniki (2538 przeskanowanych plików):

| harness | pliki własne | linie własne | pliki współdz. | odwołania | branch | import |
| --- | --- | --- | --- | --- | --- | --- |
| openrouter | 17 | 2 499 | 164 | 778 | 48 | 22 |
| mistral | 15 | 2 000 | 89 | 526 | 41 | 16 |
| zai | 10 | 1 289 | 69 | 420 | 39 | 15 |
| mimo | 8 | 1 387 | 60 | 383 | 33 | 12 |
| opencode | 51 | 12 381 | 357 | 2 996 | 53 | 30 |
| codebuddy | 19 | 3 347 | 124 | 587 | 42 | 24 |
| deepseek | 32 | 5 073 | 190 | 1 071 | 52 | 36 |
| qwen | 19 | 4 134 | 180 | 864 | 39 | 24 |
| **razem** | **171** | **32 110** | **498** | **7 625** | **347** | **179** |

Wnioski dla B2–B4:
1. **Gałęzi jest 347, a nie ~276**: liczone są też `case` i porównania odwrócone.
   61% z nich (213) siedzi w 6 plikach: `app_front/chat.js` (63),
   `lib/routes/chats-routes.js` (53), `chatModelSelect.js` (41),
   `sdk-transport-labels.js` (24), `agent-transport.js` (16), `harness-catalog.js` (16).
2. **9 punktów wejścia importuje wszystkie 8 harnessów**: `chats-routes`,
   `harness-catalog`, `harness-status`, `ws-router`, `settings-routes`,
   `register-app-routes`, `harness-models-refresh`, `mcp/adapters/index`, `App.js`.
   B2 zaczyna od nich: zamiana statycznych importów na iterację po rejestrze
   to warunek B3 i dotyka niewielu plików.
3. **45% odwołań (3 447) to testy, w 335 plikach.** Testy delegacji
   i runtime używają `opencode`/`deepseek` jako przykładowych transportów.
   Zamiast przepisywać je pojedynczo, potrzebny jest w B2 fałszywy transport testowy
   (fixture), na który przełączą się testy rdzenia.
4. **Front ustawień to największy pojedynczy dług**: `lanSettings.js` ma 511
   odwołań, a i18n 629. Ekran z `settingsSchema` i klucze i18n w paczce pluginu
   usuwają większość odwołań we froncie poza `chat.js`.
5. **Klaster opencode + zai + mimo**: zai i mimo działają przez runtime opencode
   (`opencode-zai-api-key`, `opencode-mimo-api-key`; krawędzie opencode→zai 112,
   opencode→mimo 52). Wyprowadzane są razem i po opencode.
6. **OpenRouter jest używany przez 7 innych harnessów** w ich plikach własnych,
   co potwierdza D2: klient zostaje w rdzeniu, do pluginu idzie tylko harness czatu.
7. **Opencode jest wpięty w proces serwera**: `server.js` (37 odwołań, env
   `CRETLI_OPENCODE_INSTANCE_FOLDER`) i `memory-monitor.js` (55). Cykl życia
   serwera opencode trzeba w B2 przenieść za hook pluginu (`processLifecycle`).

Kolejność wyprowadzki w B3 (od najsłabiej sprzężonych):
**mistral (pilot)** → qwen → codebuddy → deepseek → harness czatu openrouter →
klaster opencode + zai + mimo.

**B2. Rejestr capabilities zamiast `if (transport === 'qwen')`**

*Krok 1, 2026-10-21: 3 z 9 punktów wejścia.* Zamiast nowego rejestru
rozbudowany został istniejący pilot WR1, `lib/agent-harness/builtin-harness-providers.ts`.
To główny *composition root*, który importuje harnessy po nazwie, i w B3
zastąpi go loader pluginów. Deskryptor ma `handler` i `handlerLabel` (WebSocket)
oraz `registerRoutes(app, ctx)` i jest gotowy dla 10 transportów.
`sdk` (Cursor) nie ma deskryptora i dalej jest catch-all routera.
- `lib/ws/ws-router.ts`: 10 gałęzi `isXChat → handleXAgentWebSocket` zastąpił
  jeden lookup `getBuiltinHarnessProvider(getChatAgentTransport(chat))`.
  Kolejność się nie zmienia: rejestr, potem plugin lokalny, potem catch-all SDK.
- `lib/register-app-routes.js`: 10 wywołań `registerXRoutes` zastąpiło jedno
  `registerBuiltinHarnessRoutes`. Lista deskryptorów zachowuje dawną kolejność rejestracji tras.
- `lib/mcp/adapters/index.js` zostaje **drugim, lekkim composition rootem**
  ze statycznymi importami samych plików adapterów. Próba wpięcia go pod
  deskryptory dała cykl inicjalizacji: `room-kernel` → … → adapters →
  providers → `openrouter-agent-ws` czyta stałą `room-kernel` przed jej
  inicjalizacją (TDZ). Na pełnym zestawie padło przez to 73 plików testów.
  Test pilnuje teraz, że `adapters/index.js` nie importuje modułu providerów.
  W B3 plugin musi więc dostarczać adapter MCP osobnym, lekkim wejściem.
  Nazwy z prototypu (`toString`, `constructor`) zwracają teraz `null`.
- Typy: `HarnessWsDeps`, `HarnessChatHandler`, `HarnessRoutesContext`,
  `HarnessMcpAdapter` (`callControl: 'bridge' | 'managed' | 'native'`).
  `builtin-harness-providers.js` i `mcp/adapters/index.js` dołączyły do poziomu strict.
- Inwentarz: oba composition rooty są raportowane osobno (`compositionRoots`)
  i nie liczą się jako sprzężenie.
- **Świadomie pominięte**: guard PTY legacy w `ws-router` (`/ws-agent` z
  `resumeId`) zamyka czaty 9 harnessów kodem 4000, ale **pomija zai i mimo**.
  Dziś czat zai/mimo z `resumeId` trafia do handlera PTY. Wygląda to na
  przeoczenie, ale to zmiana zachowania, więc wymaga decyzji, zanim guard
  przejdzie na rejestr.
*Krok 2, 2026-10-21: `harness-status` i `harness-models-refresh` (5 z 9).*
- Nowy lekki composition root `lib/agent-harness/builtin-harness-backends.ts`
  obejmuje **wszystkie** transporty, także `sdk`. Każdy ma `status()` (available/configured),
  `refreshModels(deps)` (`null` dla opencode z `notRefreshableReason`) i
  `refreshIsNetworkInference` (Codex). Importuje tylko moduły kluczy API,
  dostępności CLI/SDK i list modeli, a nigdy `*-agent-ws.js` ani rejestru
  providerów. Test pilnuje obu zakazów, żeby status i katalog nie weszły w cykl `room-kernel`.
- `lib/harness-status.js`: zamiast 22 importów i 11 par zmiennych jest jedna pętla po
  backendach. Sondy idą sekwencyjnie w tej samej kolejności, a kształt odpowiedzi się nie zmienia.
- `lib/harness-models-refresh.js`: drabinkę `if (harness === …)` zastąpiło
  `backend.refreshModels(deps)`. `REFRESHABLE_HARNESSES` i `NOT_REFRESHABLE_HARNESSES`
  wynikają z rejestru (ten sam zbiór, inna kolejność). Seamy testowe
  (`list<Harness>Models`, `runCodexProbe`, `codexHomeDir`, `loadCursorSdk`) działają bez zmian.
- `model-catalog.js`: parametry `mergeModelCatalogEntries` i `expandSdkModelsToCatalog`
  oznaczone jako `readonly` (funkcje ich nie mutują).
- Strict: + `builtin-harness-backends.js`, `harness-status.js` (8 plików).
*Krok 3, 2026-10-21: `harness-catalog` (6 z 9).*
- Backendy dostały pola katalogu przeniesione 1:1 z `harness-catalog.js`:
  `enabledModelsKey` (klucz ulubionych w Settings), opcjonalne `normalizeEnabledModels`
  (deepseek, codebuddy), `favoritesMatchVariants` (claude: ulubiony model
  włącza warianty), `credentialsReadySync()` (sync sonda dla bramek startu) oraz
  `offlineCatalog(enabled)`, czyli katalog bez wywołania vendora. `null` dla opencode i openrouter
  oznacza ogólną ścieżkę „lista z Settings albo brak katalogu”, która zostaje w `harness-catalog`.
- `lib/harness-catalog.js`: zniknęły `ENABLED_MODEL_KEYS`, `switch` sondy poświadczeń,
  drabinka `if (harness === …)` katalogu offline, czytnik cache Codexa i
  21 importów harnessów. Plik ma teraz 0 odwołań do konkretnych harnessów.
- `catalogEntriesFromEnabledIds` przeniesione do `model-catalog.js` jako
  eksport `catalogEntriesFromModelIds`, bo potrzebują go katalog i backendy.
- `harness-catalog.js` **nie** wszedł do poziomu strict: ma 17 błędów strict
  w nieruszanym kodzie pluginów lokalnych i wierszy delegacji.
*Krok 4, 2026-10-21: `chats-routes` (7 z 9).*
- Deskryptory providerów (ciężkie, bo operują na runtime) dostały: `room`
  (`getDiag`, `dispose`, `syncModel`; `null` dla openrouter, który nigdy nie
  synchronizował modelu), `checkCreateReady(ctx)` (bramka 503 przy tworzeniu czatu,
  z komunikatami 1:1; opencode sprawdza `getOpenCodeHealth` z leniwie liczonym folderem),
  `chatTitlePrefix` oraz `historyStatusTail` (`false` dla opencode i openrouter).
  Bramka idzie do providerów, a nie do lekkich backendów, bo `getOpenCodeHealth`
  ciągnie runtime opencode z jego SDK.
- `lib/routes/chats-routes.js`: zastąpione zostały diag (11-poziomowy ternary), dwa miejsca
  dispose, sync modelu, drabinka bramki tworzenia (150 linii), ternary tytułu
  i lista `status-tail`. Zniknęło 41 importów harnessów. `sdk` i kontekst Codexa
  (core) zostają jawne. Pomocnik `builtinProviderForChat` dopasowuje dokładne
  zapisane id, tak jak dawne `chat.agentTransport === '<id>'`.
  Zostały 2 odwołania, oba w tekście komunikatu dla użytkownika.
- Gałęzie po transporcie w całym repo: 347 → 271.

*Krok 5, 2026-10-21: `settings-routes` (8 z 9).*
- Każdy z 8 harnessów nie-core ma własny moduł ustawień `lib/<id>/<id>-settings.js`
  (plik własny, który w B3 przejdzie razem z pluginem). Zawiera `readClientSettings(settings)`,
  czyli pola GET /api/settings, `applySettingsPatch(body, settings)`, czyli pola PATCH
  z walidacją i komunikatami 1:1, oraz opcjonalne `requiresRuntimeReset(body)`.
  Wspólne klocki są w `lib/agent-harness/harness-settings-patch.ts`.
- Backendy mają pole `settings`. Claude, Codex i Cursor (core) mają `null`
  i zostają w `settings-routes`.
- **Kolejność ma znaczenie**: openrouter musi iść przed opencode, bo klucz Zen
  wpisany w PATCH usuwa identyczny, źle zapisany klucz OpenRouter ustawiony
  wcześniej w tym samym PATCH. Lista backendów ma teraz openrouter przed opencode.
  Kolejność kluczy w payloadzie statusu zmieniła się kosmetycznie.
- Reset runtime po zapisie: moduł ustawień mówi *czy* (`requiresRuntimeReset`),
  a provider *jak* (`resetRuntime`; opencode → `disposeAllOpenCodeInstances`),
  dzięki czemu lekki moduł ustawień nie ciągnie runtime opencode.
- `defaultNewChatHarness`: drabinkę 10 `if` zastąpiło „dowolny transport poza `sdk`”
  (ten sam zbiór).
- `lib/routes/settings-routes.js`: zniknęło 25 importów, ~330 linii bloków harnessów
  i lista warunków resetu opencode. Plik ma teraz 0 odwołań do harnessów nie-core.
- Świadoma drobna różnica: gdy jeden PATCH zawiera **kilka** błędnych pól
  (harness i core naraz), może wrócić komunikat innego pola niż wcześniej.
  Każde błędne pole nadal daje 400 i nic się nie zapisuje.
- Strict: + `harness-settings-patch.js` i 8 modułów ustawień (17 plików).

*Krok 6, 2026-10-22: `app_front/App.js` (9 z 9, punkty wejścia zamknięte).*
- Frontowy composition root `app_front/harnessModelSettingsPanels.js`
  (`HARNESS_MODEL_SETTINGS_PANELS`: `harness`, `init`, `refresh`) zastąpił w `App.js`
  10 importów paneli modeli, 10 wywołań `init…` i 10 warunków `refresh…`.
  Kolejność się nie zmienia. Panel Cursor SDK (`modelSettings.js`) zostaje jawny (core).
- Zostaje świadomie: zakładka `harness-opencode-approvals` odświeża panel brokera
  zatwierdzeń (funkcja UI przypięta do zakładki opencode) oraz 2 komentarze.

*Krok 7, 2026-10-22: metadane harnessów w UI czatu z jednego rejestru frontu.*
- Nowy composition root `app_front/harnessUiRegistry.js` (dopisany do `COMPOSITION_ROOTS`
  inwentarza) trzyma dla każdego z 11 transportów: etykiety (nagłówek, picker paska
  trybu, etykieta startu sesji), zakładkę i klucz i18n Settings, pola pierwszego
  uruchomienia (`firstRunKeyField`, `firstRunKeyKinds`, `firstRunPayload`), nazwę zdarzenia
  `cretli-<id>-models-changed` i klucz włączonych modeli, kształt katalogu modeli
  (`catalogShape`), klucze błędów i etykiet kontekstu oraz flagi zachowania
  (`scopedCatalogReload`, `catalogConfirmedReadiness`, `refreshStatusOnModelsChanged`,
  `resyncPickersOnModelsChanged`, `modelsChangedCarriesCatalog`). Odczyt: `getHarnessUiMeta`,
  `resolveHarnessUiMeta`, `normalizeHarnessUiId`, `listHarnessUiMeta`.
- Zamienione na odczyt z rejestru: `sdk-transport-labels.js`, `newChatHarnessStatus.js`,
  `cr-sdk-mode-bar.js`, `harnessSettings.js`, `firstRunSetup.js`, `chatModelSelect.js`
  (stan katalogów i kluczy per transport w mapach; 20 funkcji `apply…` → `applyEnabledModels`
  i `applyAvailableModels`) oraz `chat.js` (cache gotowości, błędy, katalog modeli
  oczekującego harnessu, pętla zdarzeń `…-models-changed`).
- Gałęzie po transporcie (`npm run inventory:harness-coupling`, przed → po):
  `chat.js` 63 → 0, `chatModelSelect.js` 41 → 0, `sdk-transport-labels.js` 24 → 0,
  `harnessSettings.js` 14 → 0, `firstRunSetup.js` 13 → 0, `newChatHarnessStatus.js` 8 → 0,
  `cr-sdk-mode-bar.js` 7 → 0. Razem 263 → 93 w całym repo; odwołania w kodzie
  współdzielonym 6 942 → 6 487.
- Zostaje świadomie w `chat.js`: tabela `NEW_CHAT_STATUS_REFRESHERS` (10 funkcji
  `refreshNewChat<Harness>Status` czyta różne pola statusu i teksty błędów — to kod
  per harness, który w B3 przechodzi do modułów harnessów) oraz literały id w tych funkcjach.
- Zachowanie bez zmian, w tym jedna zachowana osobliwość: `cr-sdk-mode-bar.js` nie
  normalizował `mimo` (jest na liście pickera, ale `normalizeBarHarness('mimo')` zwraca
  fallback); rejestr odtwarza to flagą `modeBarNormalized: false`.
- Test: `tests/harness-ui-registry.test.js` (każdy transport z `lib/agent-transport.js`
  ma wpis, etykiety/zdarzenia/kolejności zgodne ze starymi wartościami).

*Krok 8, 2026-10-22: ekran ustawień harnessów ze schematu (`lanSettings.js`).*
- Każdy z 8 modułów `lib/<id>/<id>-settings.js` eksportuje `settingsSchema` (czyste dane
  w `lib/<id>/<id>-settings-schema.js`, bez importów serwerowych, więc front może je
  zaimportować statycznie; API ustawień się nie zmienia). Kształt: `fields` (`name`,
  `kind`: secret|string|enum|int|models, `get`, `clearFlag`, `values`), `readOnly`
  (pola tylko w GET, np. flagi `…FromEnv`) oraz `ui` (`groups` z regułami podpowiedzi
  `when` → klucz i18n, `secrets`, `texts`, `selects`, `keyChangedEvent`). Typy:
  `lib/agent-harness/harness-settings-patch.ts`. Klucze i18n bez zmian.
- Front: `app_front/features/settings/harnessSettingsRenderer.js` czyta schematy z nowego
  composition roota `app_front/harnessSettingsSchemas.js` (dopisany do `COMPOSITION_ROOTS`)
  i podpina istniejący markup: podpowiedzi stanu klucza, przyciski zapisu/usuwania,
  selecty i zdarzenia `cretli-<id>-key-changed`. Markup sekcji zostaje w `public/index.html`
  (te same id DOM). Jedyne zachowanie spoza schematu — wybór endpointu Qwen (pole
  niestandardowego URL i dołączanie endpointu do zapisu klucza) — to hook w composition roocie.
- `app_front/lanSettings.js`: ~810 linii mniej, odwołania do harnessów nie-core
  511 → 0 (inwentarz); odwołania w całym kodzie współdzielonym 6 487 → 6 039.
- Test: `tests/harness-settings-schema.test.js` — nazwy pól schematu = klucze
  `readClientSettings`, każde pole i `clearFlag` jest przyjmowane przez `applySettingsPatch`,
  UI odwołuje się tylko do zadeklarowanych pól.

*Krok 9, 2026-10-22: klucze i18n harnessów w paczkach per harness.*
- Teksty specyficzne dla 8 harnessów nie-core (289 kluczy w każdym języku) przeniesione z
  `app_front/i18n/en.js` i `pl.js` do paczek `app_front/i18n/harness/<id>.en.js` i
  `<id>.pl.js` (zagnieżdżone fragmenty o tych samych ścieżkach). Kryterium: nazwa harnessu
  w ścieżce klucza; ogólne teksty, które tylko wspominają harness w wartości (9 kluczy),
  zostają w słowniku bazowym. Klucze MCP (`settings.mcpTab*`, `externalMcp*`) bez zmian.
- Paczki scala `mergeDictionaries` (nowe klucze i rozszerzanie sekcji; kolizja klucza
  rzuca błąd, paczka nie nadpisuje tekstu). Scalanie dzieje się przy ładowaniu modułu
  słownika: `en.js` eksportuje słownik już scalony, a paczki PL trafiają do leniwego
  chunka `i18n-pl` razem z `pl.js`; wszyscy importujący `en`/`pl` (loader, testy) widzą
  pełny słownik. Wybrano osobne pliki per język zamiast `{ en, pl }`, żeby polskie teksty
  nie wchodziły do głównego bundla. Plugin dostarczy własne paczki tym samym kształtem.
- Composition roots: `i18n/harness/packs.en.js` i `packs.pl.js` (w `COMPOSITION_ROOTS`).
- Odwołania do harnessów w słownikach (inwentarz, przed → po): `en.js` 311 → 12,
  `pl.js` 318 → 19; kod współdzielony 6 039 → 5 441 odwołań.
- Test: `tests/i18n-harness-packs.test.js` porównuje scalone `en`/`pl` z migawkami
  `tests/fixtures/i18n-snapshot-{en,pl}.json` zrobionymi przed przeniesieniem (te same
  klucze i wartości) oraz sprawdza parzystość paczek en/pl i reguły scalania.

*Krok 10, 2026-10-22: testowy transport zamiast opencode/deepseek w testach rdzenia.*
- `tests/fixtures/fake-transport.js` rejestruje na czas procesu testowego dwa fałszywe
  transporty: `testfake` i `testfakeb` (gdy test potrzebuje dwóch różnych harnessów) oraz
  mockowy adapter chat-run dla nich. Import fixture'a to jedyny sposób rejestracji.
- Mechanizm w `lib/agent-transport.js`: `registerTestAgentTransport(id, { profileOf })`
  (odmawia przy `NODE_ENV=production` i nie pozwala przesłonić id wbudowanego) oraz
  `resolveAgentTransportProfile`. Id testowe nie trafiają do `VALID_TRANSPORTS`, rejestru
  `listHarnesses`, ustawień ani katalogów; `parseKnownAgentTransport` i
  `isKnownHarness` je akceptują. `profileOf` odbija statyczne tabele polityk wbudowanego
  harnessu (capabilities adaptera, traits review, pole id sesji, kontrakt recovery,
  follow-up werdyktu), dzięki czemu asercje testów zostają bez zmian.
- Przepięte: 118 plików (`delegation-*`, `workspace-watcher*`, `recovery-*`,
  `reviewer-*`, `model-pick-*`, `orchestrator-*`). Zostają przy prawdziwych harnessach
  testy ich zachowania: m.in. `delegation-executor` (klucz ustawień `opencodeChatEnabledModels`),
  `delegation-phase3-adapter-guards`, `recovery-adapter-validation`, `recovery-contract`,
  `delegation-metrics`, `model-pick-rotation`, `workspace-watcher` i `-stats`,
  `reviewer-todo-pair`, `reviewer-pair-unstartable-member` (katalogi i ulubione per harness).
- Odwołania w obszarze tests (inwentarz, przed → po): opencode 1 826 → 1 067,
  deepseek 631 → 469; pozostałe harnessy bez zmian.
- Test: `tests/fake-transport-isolation.test.js` — bez fixture'a id jest nieznane, kod
  produkcyjny nie ładuje fixture'a ani nie woła hooka, a po rejestracji id nie jest widoczne
  w `VALID_TRANSPORTS` ani `listHarnesses`; normalizery ustawień (`enabledHarnesses`, `harnessOrder`)
  bez fixture'a odrzucają `testfake`.

*Krok 11, 2026-10-22: cykl życia procesów opencode za hookiem `processLifecycle`.*
- Deskryptor providera ma opcjonalny `processLifecycle` (typ `HarnessProcessLifecycle`
  w `lib/agent-harness/harness-plugin-contract.ts`): `start` (sweep przy starcie),
  `beginStop` (faza 1, synchroniczna) i `finishStop` (faza 2, ograniczone czekanie),
  `getStats`, `listInternalPorts` oraz `monitor` (domyślna konfiguracja i env, rejestr
  właścicieli, probe'y, `evaluate`, `formatReport`, `listExecutors` dla monitora pamięci).
- Implementacja opencode: `lib/opencode/opencode-process-lifecycle.js` (do niego
  przeniesiono klasyfikację `opencode serve` z `lib/memory-monitor.js`). Menedżer serwera
  ładuje się leniwie w `start()`, więc monitor nie ciągnie runtime'u czatu.
- Rdzeń: `server.js` iteruje `listProcessLifecycleProviders()` przez
  `lib/agent-harness/process-lifecycle-runner.ts` (kolejność bez zmian: faza 1 przed
  rejestrem procesów potomnych, faza 2 po nim, przed przeglądarką i delegacjami).
  Monitor pamięci czyta hooki z lekkiego `builtin-process-lifecycles.js`, który nie
  importuje modułu providerów (composition roots `builtin-harness-backends.js`
  i `mcp/adapters/index.js` nadal go nie importują). Zgodność env zostaje:
  `CRETLI_OPENCODE_INSTANCE_FOLDER`, `CRETLI_MEMORY_MONITOR_MAX_OPENCODE`.
- Klucz kontekstu tras diagnostyki: `getOpenCodeInstanceStats` → `getInstanceStats`
  (po stronie `server.js`).
- Odwołania w inwentarzu (przed → po): `server.js` 44 → 13 (zostaje blok env zgodności),
  `lib/memory-monitor.js` 55 → 0.
- Test: `tests/harness-process-lifecycle.test.js` (deskryptor, monitor przez hook,
  kolejność start/stop fałszywego providera, izolacja błędów); asercje kolejności
  w `tests/server-shutdown-wiring.test.js` przepięte na runner.

*Krok 12, 2026-10-22: loader wtyczek z repo wpięty w boot (B3, krok 1; żaden harness nie został przeniesiony).*
- Kontrakt (`harness-plugin-contract.js`): origin `builtin-optional`, pole `entries`
  (`light` / `heavy` / `front`, bezpieczne ścieżki `.js`, co najmniej `light` lub `heavy`),
  `entry` zabronione, `entries` zabronione dla pozostałych originów. Zarezerwowane
  są tylko id rdzenia (`HARNESS_CORE_RESERVED_IDS`); status domyślnie wyłączony (opt-in).
  Loader `local` bez zmian — odrzuca ten origin.
- Loader: `lib/agent-harness/optional-harness-plugins.ts` czyta `harnesses/<id>/`
  (katalog z repo, nie z env), waliduje manifest (id = nazwa katalogu, brak symlinków,
  pliki wewnątrz katalogu wtyczki) i importuje tylko id z `CRETLI_OPTIONAL_HARNESSES`.
  Oba wejścia są importowane i sprawdzane przed rejestracją; błąd jednej wtyczki
  jest logowany i pomijany. Stan załadowanych id: `optional-harness-state.js`
  (bez importów, czyta go `/api/settings` jako `optionalHarnesses`).
- Cztery rejestry dostały rejestrację opcjonalną (odmawiają kolizji id, więc wtyczka
  nie zasłoni wbudowanego harnessu; następny krok usunie wpis wbudowany przy przenosinach):
  `registerOptionalHarnessProvider` (providers), `registerOptionalHarnessBackend`
  (backends), `registerOptionalHarnessMcpAdapter` (adaptery MCP) i front:
  statyczna mapa `app_front/optionalHarnessPanels.js` + `activateOptionalHarnessPanels`
  w `harnessModelSettingsPanels.js` (bez fs w runtime, webpack rozwiązuje importy).
  Eksport light (`default { backend, mcpAdapter }`) i heavy (`default { provider }`).
- Boot: `server.js` ładuje wtyczki przed odczytem rejestrów; bez ustawionej zmiennej
  nic nie jest czytane ani rejestrowane, więc zachowanie serwera jest identyczne.
- Test: `tests/optional-harness-plugins.test.js` (kontrakt, odrzucenie przez loader
  `local`, ładowanie fixture'a do trzech rejestrów, izolacja błędów i kolizji,
  zakaz importów `room-kernel`/providers w wejściu `light` liczony tranzytywnie,
  kolejność w bootcie, statyczna mapa frontu). Fixture: `tests/fixtures/optional-harness/`.

*Krok 13, 2026-10-22: mistral jako pierwsza wtyczka z repo (B3, pilot; liść 9ef16c38).*
- Decyzja: pole manifestu `defaultEnabled` (boolean, domyślnie `false`, tylko dla
  `builtin-optional`). Zmienna `CRETLI_OPTIONAL_HARNESSES` **nieustawiona** → ładują się
  wtyczki z `defaultEnabled: true`; **ustawiona** (także pusta) → dokładnie podana lista.
  Mistral ma `defaultEnabled: true`, więc istniejące instalacje nic nie tracą;
  `CRETLI_OPTIONAL_HARNESSES=` (pusta) wyłącza go całkowicie.
- Pliki własne mistrala przeszły do `harnesses/mistral/`: `mistral-*.js` (ws, klient, SDK,
  modele, klucz API, ustawienia, schemat ustawień, hydratacja rozmowy), `mistral-routes.js`,
  `mistral-adapter.js` (MCP), `front.js` (dawniej `app_front/mistralModelSettings.js`),
  paczki i18n `mistral.en.js` / `mistral.pl.js`, `SETUP.md` oraz testy
  (`harnesses/mistral/tests/`, runner `scripts/run-unit-tests.mjs` je odkrywa).
  Nowe wejścia: `light.js` (backend: status, katalog, ustawienia + adapter MCP),
  `heavy.js` (provider: handler, trasy, pokój, `checkCreateReady`), `front.js`
  (`init` / `refresh`), manifest `harness-plugin.json`. Nie ma shimów w starych ścieżkach.
- Cztery composition rooty (`builtin-harness-providers.js`, `builtin-harness-backends.js`,
  `mcp/adapters/index.js`, `harnessModelSettingsPanels.js`) nie wspominają już mistrala;
  panel frontu wchodzi przez statyczną mapę `app_front/optionalHarnessPanels.js`
  (webpack rozwiązuje import).
- Metadane (`label`, `description`) wtyczki trafiają do `registry.js`
  (`registerOptionalHarnessMeta`, kolejność listy jak w `AGENT_TRANSPORTS`), więc wyłączony
  harness znika z `harness_list`, katalogu i `GET /api/harnesses`. `REFRESHABLE_HARNESSES`
  / `NOT_REFRESHABLE_HARNESSES` (snapshot z importu) zastąpiły funkcje
  `listRefreshableHarnesses()` / `listNotRefreshableHarnesses()`, bo wtyczka dołącza do
  rejestru backendów dopiero po załadowaniu modułu.
- Zostaje bez zmian (dane zapisane i zgodność, następny liść 5efe99af): id `mistral`
  w `VALID_TRANSPORTS` / `AGENT_TRANSPORTS`, `DEFAULT_HARNESS_ORDER`, `harnessUiRegistry.js`,
  paczki i18n w `packs.*.js` (importują teraz z `harnesses/mistral/`), schemat ustawień
  w `harnessSettingsSchemas.js`, trasy SPA / service worker oraz klucze `mistral*` w ustawieniach.
  Przy włączonej wtyczce (domyślnie) zachowanie jest identyczne; kolejność tras HTTP
  providerów: mistral rejestruje się po wbudowanych (trasy mają osobne prefiksy `/api/mistral/`).
- Odwołania mistrala w kodzie współdzielonym (inwentarz, przed → po): 238 → 228
  (`settings_ui` 37→35, `models` 39→38, `tests` 88→83, `capability` 35→33; `auth` 8,
  `usage_pricing` 25, `i18n` 6 bez zmian). W czterech composition rootach: 38 → 0
  (w `optionalHarnessPanels.js` 5, to mapa wtyczek). Skrypt inwentarza skanuje też
  `harnesses/` (pliki własne wtyczki) i traktuje `optionalHarnessPanels.js` jak composition root.
- Testy: `tests/optional-harness-plugins.test.js` (walidacja `defaultEnabled`, tryb
  nieustawiony / pusty / lista), `harnesses/mistral/tests/mistral-plugin.test.js`
  (manifest, zakaz importów w `light`, brak nazwy w rootach, proces potomny z hookiem
  rejestrującym załadowane moduły: wyłączony → zero modułów `harnesses/mistral`,
  włączony → rejestry pełne). Testy wymagające mistrala w rejestrach ładują go przez
  `tests/helpers/default-optional-harnesses.js` (jak boot).

*Krok 14, 2026-10-22: qwen jako druga wtyczka z repo (B3, liść 0d367c28, partia 1/4: qwen; codebuddy i deepseek idą w kolejnych partiach).*
- Wzorzec jak w kroku 13: `harnesses/qwen/` z `harness-plugin.json` (`origin: builtin-optional`,
  `defaultEnabled: true`, `capabilities: { chat, models }`) oraz wejściami `light.js`, `heavy.js`, `front.js`.
  Przeszły tam: `qwen-*.js` (ws, klient SDK, modele, klucz API, CLI, ustawienia, schemat ustawień,
  kontekst, błędy API), `qwen-routes.js`, `qwen-adapter.js` (MCP), `qwen-event-normalizer.js`,
  nowy `qwen-tool-result.js` (klasyfikacja wyników narzędzi), `front.js` (dawniej
  `app_front/qwenModelSettings.js`), paczki i18n `qwen.en.js` / `qwen.pl.js`, `SETUP.md`
  (dawniej `docs/qwen/`) oraz testy w `harnesses/qwen/tests/`. Katalogi `lib/qwen/` i `docs/qwen/` znikają,
  bez shimów.
- Cztery composition rooty (`builtin-harness-providers.js`, `builtin-harness-backends.js`,
  `mcp/adapters/index.js`, `harnessModelSettingsPanels.js`) oraz `registry.js` nie wspominają już qwena.
  Front: wpis `qwen` w `OPTIONAL_HARNESS_LOADERS` (dynamiczny `import()` panelu i schematu →
  osobne chunki `harnesses_qwen_front_js` i `harnesses_qwen_qwen-settings-schema_js`); i18n zostaje statyczne
  w paczkach. `harnessSettingsSchemas.js` nie importuje już schematu qwena ani nie zawiera jego haków DOM:
  `registerHarnessSettingsSchema(schema, hooks)` przyjmuje haki, a `front.js` eksportuje `settingsHooks`
  (pola endpointu Qwen), rejestrowane razem ze schematem przez `activateOptionalHarnessPanels`.
- Nowe punkty rozszerzenia wejścia `light` (potrzebne, bo qwen był też wymieniony w kodzie współdzielonym):
  `titleProvider` (generator tytułów przez endpoint zgodny z OpenAI; `registerOptionalTitleProvider` w
  `lib/chat-title-providers.js`, kolejność `auto` zachowana przez `insertBefore`) oraz `versions`
  (wiersz tabeli wersji + resolver źródła CLI; `registerOptionalHarnessVersions` w `lib/harness-versions.js`).
  Loader sprawdza kolizje obu rejestrów przed rejestracją, jak pozostałych. Dla codebuddy / deepseek
  (też mają wiersz wersji; deepseek ma generator tytułów) te same punkty będą użyte w kolejnych partiach.
- Współdzielone narzędzie pytań (`ask_user_question` / `AskUserQuestion`), używane też przez Claude'a
  (`claude-agent-ws.js`, `can-use-tool-permission.js`), nie mogło zostać w plugine: przeniesione do
  `lib/approval/ask-user-question.ts` z neutralnymi nazwami (`createAskUserQuestionCanUseTool`,
  `isAskUserQuestionTool`, `ASK_USER_QUESTION_TIMEOUT_MS` itd.); części czysto qwenowe (wyniki narzędzi)
  trafiły do pluginu. Test: `tests/ask-user-question.test.js` (rdzeń) i `harnesses/qwen/tests/qwen-tool-result.test.js`.
- Ścieżka wyłączonego pluginu (B4, liść 5efe99af) jest ogólna; dla qwena przypięta testem
  `harnesses/qwen/tests/qwen-disabled.test.js` (wykrycie z manifestu, odmowa promptów bez zapisu,
  katalog `enabled:false`, `harness_unavailable`, `model_pick`, klucze zostają). Test procesu potomnego
  `harnesses/qwen/tests/qwen-plugin.test.js`: `CRETLI_OPTIONAL_HARNESSES=` (bez qwena) → zero modułów
  `harnesses/qwen` i `@qwen-code` w załadowanych URL-ach, qwen nieobecny w rejestrach, tytułach i wersjach.
- Zostaje bez zmian (dane i zgodność): id `qwen` w `VALID_TRANSPORTS` / `AGENT_TRANSPORTS`,
  `DEFAULT_HARNESS_ORDER`, `harnessUiRegistry.js`, paczki i18n, trasy SPA / service worker, klucze
  `qwen*` w ustawieniach. Testy rdzenia, które wymagają qwena w rejestrach, ładują go przez
  `tests/helpers/default-optional-harnesses.js`. Kolejność wiersza qwena w liście harnessów
  i wersji nie zmienia się (po codex, przed claude); w providerach pluginy dołączają po wbudowanych.
- Odwołania qwena w kodzie współdzielonym (inwentarz, przed → po): 598 → 569 (`capability` 83→61,
  `models` 36→32, `auth` 21→17, importy 12→8; `tests` 397→398 — testy pluginu liczą się jako własne,
  ale pliki rdzenia nadal wymieniają id). Pliki własne 23 → 27. W composition rootach (`harnessModelSettingsPanels`,
  `harnessSettingsSchemas`, `builtin-harness-backends`, `builtin-harness-providers`, `mcp/adapters/index`): 50 → 0;
  `optionalHarnessPanels.js` 3 (mapa pluginów), `harnessUiRegistry` 8 i paczki i18n 4 bez zmian.
  Pliki z największym spadkiem: `chat-title-providers.js` 13→0, `harness-versions.js` 11→0,
  `registry.js` 3→0, `claude-agent-ws.js` 2→0.

*Krok 15, 2026-10-22: codebuddy jako trzecia wtyczka z repo (B3, liść 0d367c28, partia 2/4).*
- Ten sam wzorzec co qwen (krok 14): `harnesses/codebuddy/` z `harness-plugin.json` (`builtin-optional`,
  `defaultEnabled: true`, `capabilities: { chat, models }`), `light.js` (backend z `normalizeEnabledModels`,
  adapter MCP, wiersz wersji z `insertBefore: 'codex'`, żeby kolejność codebuddy → deepseek → codex przetrwała przeniesienie deepseeka), `heavy.js`, `front.js`. Bez generatora tytułów
  (codebuddy nigdy go nie miał). Przeszły tam: `codebuddy-*.js` (ws, klucz API, CLI, live-session, pamięć,
  modele, SDK, ustawienia, schemat), `codebuddy-event-normalizer.js`, `codebuddy-routes.js`, `codebuddy-adapter.js`,
  `front.js` (dawniej `app_front/codebuddyModelSettings.js`), paczki i18n, `SETUP.md` oraz 8 testów
  (`harnesses/codebuddy/tests/`). `lib/codebuddy/` i `docs/codebuddy/` znikają, bez shimów.
- Nowy punkt w kodzie współdzielonym: `lib/delegation-executor.js` czyścił ulubione modele codebuddy przez import
  z modułu modeli; teraz używa `normalizeEnabledModels` z deskryptora backendu (jak `harness-catalog.js`).
  `harness-versions.js` i `registry.js` nie wspominają już codebuddy; rooty (`providers`, `backends`, `mcp/adapters/index`,
  `harnessModelSettingsPanels`, `harnessSettingsSchemas`) mają 0 odwołań. Front: wpis w `OPTIONAL_HARNESS_LOADERS`
  (osobne chunki `harnesses_codebuddy_front_js` i `harnesses_codebuddy_codebuddy-settings-schema_js`).
- Testy: `codebuddy-plugin.test.js` (manifest, zakaz importów w `light`, rooty bez nazwy, proces potomny:
  wyłączony → zero modułów `harnesses/codebuddy` i `@tencent-ai`, włączony → rejestry pełne i pozycja jak dawniej),
  `codebuddy-disabled.test.js` (B4: wykrycie z manifestu, odmowa promptów bez zapisu, katalog, `harness_unavailable`,
  `model_pick`, klucze zostają). Testy rdzenia wymagające codebuddy w rejestrach ładują go przez
  `tests/helpers/default-optional-harnesses.js`.
- Ograniczenie do decyzji: straż poleceń review (`sdk-plan-guard.ts`: `node --test`; `sdk-review-lint.ts`) przepuszcza
  tylko pliki z `tests/` (oraz `lib`, `app_front`, `scripts` dla lintu), więc dziecko review nie uruchomi testów ani
  nie zlintuje plików z `harnesses/` (dotyczy też mistrala i qwena). Test live-session codebuddy sprawdza straż na plikach rdzenia.
- Odwołania codebuddy w kodzie współdzielonym (inwentarz, przed → po): 371 → 353 (`capability` 66→48, `models` 26→24,
  importy 7→6, gałęzie 9→8; `tests` 224→226). Pliki własne 23 → 27; pliki współdzielone 116 → 114. W composition rootach
  (5 zmienionych): 47 → 0; zostają `optionalHarnessPanels.js` 3, `harnessUiRegistry` 7 i paczki i18n 4. Największe spadki:
  `harness-versions.js` 15→0, `registry.js` 3→0, `delegation-executor.js` 3→1.

*Krok 16, 2026-10-22: deepseek jako czwarta wtyczka z repo (B3, liść 0d367c28, partia 3/4).*
- `harnesses/deepseek/` (manifest `builtin-optional`, `defaultEnabled: true`, `capabilities: { chat, models }`,
  wejścia `light` / `heavy` / `front`). Przeszły tam: `deepseek-*.js` (ws, klucz API, saldo, CLI, konfiguracja
  kompaktowania, cache harnessu, opcje, home, id modeli, modele, wynik runu, SDK, ustawienia, schemat), `dsh-*.js`
  (łatki runtime i review, wtyczka runtime ładowana przez dsh po ścieżce względnej, polityka fetch),
  `deepseek-event-normalizer.js`, `deepseek-routes.js`, `deepseek-adapter.js`, `mcp-deepseek-patch.js` (dawniej
  `lib/mcp/`), `front.js`, paczki i18n, `SETUP.md` i 13 testów (`harnesses/deepseek/tests/`). `lib/deepseek/`
  i `docs/deepseek/` znikają, bez shimów.
- Nowy plik pluginu `deepseek-ledger.js`: trasy `/api/credit-ledger/deepseek-balance[/refresh]` i odczyt salda po
  zaksięgowanym top-upie wyjechały z `credit-ledger-routes.js`.
- Nowe punkty rozszerzenia (host, `lib/agent-harness/optional-harness-hooks.ts`, rejestrowane z wejścia `light`
  przez loader z kontrolą kolizji): `limitBinding` (pola dopisywane do blokady limitu — `room-kernel.js`),
  `billingCredential` (źródło poświadczenia konta rozliczeniowego — `billing-account-registry.js`) i `creditLedger`
  (`registerRoutes`, `onTopupPosted`). Dobowy odczyt salda startuje jako `processLifecycle.start` providera
  (zamiast bloku w `server.js`) i jest zatrzymywany w `beginStop`.
- Front: `OPTIONAL_HARNESS_LOADERS` (osobne chunki panelu i schematu); moduł panelu może eksportować
  `normalizeEnabledModels`, rejestrowane w `harnessUiRegistry` (`registerHarnessEnabledModelsNormalizer`), więc
  `harnessUiRegistry.js` i `harnessModelUsage.js` nie importują już pliku z pluginu. `delegation-executor.js` czyści
  ulubione przez `normalizeEnabledModels` deskryptora backendu (jak codebuddy).
- Kolejność: generator tytułów deepseek, qwen, codex i wiersz wersji deepseek przed codex zachowane (`insertBefore`),
  pozycja na liście harnessów bez zmian.
- Testy: `deepseek-plugin.test.js` (manifest, zakaz importów w `light`, rooty bez nazwy, proces potomny:
  wyłączony → zero modułów `harnesses/deepseek` i `@deepseek-ai`, zero hooków hosta, brak lifecycle; włączony → rejestry,
  hooki i lifecycle), `deepseek-disabled.test.js` (B4).
- Odwołania deepseek w kodzie współdzielonym (inwentarz, przed → po): 696 → 633 (`capability` 90→64, `usage_pricing` 44→31,
  `models` 44→35, `auth` 18→13, importy 17→3, `tests` 470→460). Pliki własne 36 → 43; pliki współdzielone 152 → 143. W pięciu
  composition rootach: 45 → 0; `harnessUiRegistry` 9→7, `optionalHarnessPanels` 3, paczki i18n 4. Największe spadki:
  `harness-versions.js` 15→0, `chat-title-providers.js` 12→0, `credit-ledger-routes.js` 8→0, `billing-account-registry.js` 5→0,
  `server.js` 4→0, `room-kernel.js` 3→0, `registry.js` 3→0.

*Krok 17, 2026-10-22: harness czatu OpenRouter jako piąta wtyczka z repo (B3, decyzja D2; liść f370d0ad).*
- Podział zgodnie z D2. **Klient zostaje w rdzeniu** w nowym `lib/providers/openrouter/`: `openrouter-client.js`
  (dawniej `lib/agent-harness/`; strumień SSE), `openrouter-api-key.js`, `openrouter-models.js`,
  `openrouter-pricing-cache.js`, `openrouter-conversation-hydrate.js` (dawniej `lib/openrouter/`, katalog znika).
  Korzystają z niego `model-pick-*`, tytuły czatów (`chat-title-providers.js`), cost proxy, usage, `catalog-tools`,
  `delegations-routes`, klucz w `opencode-api-key.js` oraz inne harnessy (mimo, zai, mistral → hydratacja rozmowy;
  `lib/mcp/mcp-openrouter-tools.js` zostaje współdzielony). **Do wtyczki `harnesses/openrouter/` idzie tylko czat**:
  `openrouter-agent-ws.js`, `openrouter-agent-loop.js`, `openrouter-settings.js` + `openrouter-settings-schema.js`,
  `openrouter-routes.js` (`/api/openrouter/status|models`), `openrouter-adapter.js` (MCP), `front.js` (dawniej
  `app_front/openrouterModelSettings.js`), paczki i18n, manifest (`builtin-optional`, `defaultEnabled: true`,
  `capabilities: { chat }`), wejścia `light` / `heavy` / `front`. Bez shimów w starych ścieżkach.
- Wnioski z wyprowadzki: trasa `GET /api/harnesses` (lista harnessów) była zarejestrowana przez trasy OpenRoutera —
  przeniesiona do rdzenia (`harness-catalog-routes.js`), inaczej znikałaby z wyłączoną wtyczką. Wiersz meta
  (`registry.js`) i wiersz tabeli wersji (`harness-versions.js`, kanał `api`) przeszły do manifestu / wejścia `light`
  (`versions.insertBefore: 'mistral'`). Nowy punkt rozszerzenia: `backend.insertBefore` (builtin-harness-backends.js) —
  wtyczka zachowuje miejsce przed `opencode` (kolejność łatek ustawień i kluczy statusu jak dotąd).
- Decyzja o ustawieniach (poprawka po review): pola klienta — `openrouterApiKey` / `clearOpenrouterApiKey`, `openrouterSiteUrl`,
  `openrouterAppTitle`, flagi `openrouterApiKey*` w GET oraz wiersz klucza w Ustawieniach — są w rdzeniu:
  `lib/providers/openrouter/openrouter-settings.ts` + `openrouter-settings-schema.js`, rejestrowane bezwarunkowo przez
  `lib/agent-harness/core-settings-modules.ts` (stosowane przed modułami backendów, więc kolejność łatek jak dotąd) i statycznie
  w `harnessSettingsSchemas.js`. We wtyczce zostaje tylko `openrouterChatEnabledModels`. Klucz da się więc ustawić przy wyłączonej
  wtyczce (test procesu potomnego w `tests/openrouter-client-plugin-disabled.test.js`); klucze nie są kasowane (B4).
- Front: wpis `openrouter` w `OPTIONAL_HARNESS_LOADERS` (osobny chunk `harnesses_openrouter_front_js`; schemat jest w rdzeniu); `harnessModelSettingsPanels.js` nie wspomina OpenRoutera;
  `harnessSettingsSchemas.js` zawiera tylko schemat klucza (rdzeń). Provider `OPENROUTER_HARNESS_PROVIDER` przestał być eksportem statycznym (test pobiera go z rejestru).
- Testy: `harnesses/openrouter/tests/openrouter-plugin.test.js` (manifest, zakaz importów w `light`, rooty bez nazwy,
  proces potomny: wyłączony → zero modułów `harnesses/openrouter`, brak w rejestrach i wersjach; włączony → rejestry pełne,
  backend tuż przed `opencode`; brak importów pluginu z `lib/` i innych wtyczek, klient poza pluginem),
  `openrouter-disabled.test.js` (B4), `openrouter-routes.test.js`, `openrouter-agent-loop.test.js`. Rdzeń:
  `tests/openrouter-client-plugin-disabled.test.js` — proces potomny z `CRETLI_OPTIONAL_HARNESSES` bez openrouter (pusta
  lista i lista z samym mistralem): katalog modeli, cache cen, strumień SSE, cost proxy (`basis: rate` z cen katalogu),
  mapowanie usage i dostawca tytułów działają, a provider i backend czatu są nieobecne (sieć zastąpiona stubem fetch).
- Odwołania openrouter w kodzie współdzielonym (inwentarz, przed → po): 578 → 579 odwołań w 157 → 156 plikach współdzielonych
  (`capability` 65→61, `models` 37→38, `tests` 346→350; pliki własne 21 → 27, bo wtyczka ma teraz własne pliki, a pliki
  klienta w `lib/providers/openrouter/` są „własne” tylko z nazwy — inwentarz klasyfikuje po nazwie pliku, klient jest rdzeniem).
  W pięciu composition rootach (`builtin-harness-providers`, `builtin-harness-backends`, `mcp/adapters/index`,
  `harnessModelSettingsPanels`, `harnessSettingsSchemas`): 35 → 2 (tylko schemat klucza w `harnessSettingsSchemas.js`; cztery pozostałe rooty 0); `optionalHarnessPanels.js` 3 (mapa pluginów),
  `harnessUiRegistry` 6 i paczki i18n 4 bez zmian. Inne harnessy używające OpenRoutera (codebuddy, deepseek, mimo, mistral,
  opencode, qwen, zai: 7 krawędzi) zostają, ale nigdy nie importują pluginu — tylko `lib/providers/openrouter/`.

*Krok 18, 2026-10-22: klaster opencode + zai + mimo jako trzy ostatnie wtyczki z repo (B3, liść bec8aa66; B3 zamknięte).*
- Trzy wtyczki `harnesses/{opencode,zai,mimo}/` (`builtin-optional`, `defaultEnabled: true`, `capabilities: { chat, models }`,
  wejścia `light` / `heavy` / `front`; opencode ma też `lifecycle`). Przeszły (`git mv`, bez shimów): `lib/opencode/`, `lib/zai/`,
  `lib/mimo/` (razem z `zai_sdk_worker.py`), `*-routes.js`, `*-adapter.js` (MCP), `opencode-event-normalizer.js`,
  `opencode-message-registry.js`, `mcp-opencode-sync.js`, `front.js` (dawniej `app_front/{opencode,zai,mimo}ModelSettings.js`),
  schematy ustawień, paczki i18n, `SETUP.md` / `README.md` (dawniej `docs/opencode/`) i testy (`harnesses/opencode/tests/` 29,
  `harnesses/zai/tests/` 3, `harnesses/mimo/tests/` 2). Katalogi `lib/opencode`, `lib/zai`, `lib/mimo` znikają.
- **Zależność**: manifest ma nowe pole `dependsOn` (tylko `builtin-optional`; id wtyczek, nie rdzeń, bez cyklu na siebie, max 8).
  `zai` i `mimo` deklarują `dependsOn: ["opencode"]` — używają jego klucza Z.AI / MiMo i stałych. Loader układa wybrane id tak, by zależność
  ładowała się pierwsza (niezależnie od kolejności w `CRETLI_OPTIONAL_HARNESSES`), a gdy jej brak (`CRETLI_OPTIONAL_HARNESSES=zai`)
  pomija wtyczkę z błędem `dependency_missing` w logu bootu (`... needs the "opencode" plugin ... CRETLI_OPTIONAL_HARNESSES=opencode,zai`).
  Wtyczka nic nie rejestruje, więc jest „znana, ale wyłączona” (ścieżka B4 bez zmian): czaty zostają do odczytu, a komunikat nazywa brakującą
  wtyczkę (`describeDisabledOptionalHarness`). Test procesu potomnego (tymczasowy katalog danych): `harnesses/{zai,mimo}/tests/*-plugin.test.js`
  — exit 0, `dependency_missing`, zero modułów `harnesses/zai|opencode`, a z `zai,opencode` ładują się oba w kolejności `opencode`, `zai`.
- **Cykl życia procesów** (`processLifecycle` z kroku 11): nowe wejście manifestu `lifecycle` (`harnesses/opencode/lifecycle.js`, tylko hook,
  bez runtime'u czatu). Loader dołącza go do providera i rejestruje w lekkim `builtin-process-lifecycles.js` (teraz rejestr, domyślnie pusty).
  `server.js` iteruje providery z hookiem, `lib/memory-monitor.js` czyta rejestr (progi z `monitor.defaultConfig` pobierane w wywołaniu:
  `getDefaultMemoryMonitorConfig()`), a `boot-log.js` uruchamia nowy opcjonalny `warmUp` zamiast importować menedżer opencode.
  `scripts/memory-orphan-monitor.js` (systemd, bez wtyczek) rejestruje hooki przez `loadOptionalProcessLifecycles()` — czyta manifesty i
  importuje tylko wpis `lifecycle`. Ani `server.js`, ani `lib/memory-monitor.js` nie importują opencode (test
  `harnesses/opencode/tests/opencode-plugin.test.js` + `tests/harness-process-lifecycle.test.js`).
- **Co zostaje w rdzeniu** (faktycznie używane przez rdzeń; decyzja wykonawcy): (1) `lib/process-probes.js` — ogólne helpery `/proc`
  (`killProcessTree`, `getProcessStartTime`, `isRegistryOwnerAlive`, `createProcessProbes`) używane przez `child-process-registry.js`;
  port registry opencode je re-eksportuje, a `findListeningPid` dostał parametr filtra cmdline (opencode podaje `opencode`);
  (2) `lib/approval/permission-classifier.ts` — klasyfikator ryzyka i polityka zatwierdzeń (dawniej pierwsza połowa
  `opencode-permission.js`), której używają wszystkie harnessy przez `can-use-tool-adapter.js`; funkcje dostały neutralne nazwy
  (`resolveApprovalAction`, `classifyPermissionRisk`, ...), a wtyczka (`harnesses/opencode/opencode-permission.js`: SSE / HTTP odpowiedzi)
  re-eksportuje je pod dawnymi nazwami `OpenCode*`. Polityka nadal liczy się z profilem `opencode` (zachowanie bez zmian).
  Obie rzeczy są w rdzeniu, bo inaczej rdzeń musiałby importować wtyczkę (jak `lib/providers/openrouter` w kroku 17).
- Inne punkty hosta: wiersz wersji i resolver CLI opencode przeszły do `light.js` (`versions.insertBefore` przyjmuje listę kotwic — pierwsza
  obecna wygrywa; `listBuiltinHarnessBackends` też, i kotwicą może być wcześniej zarejestrowana wtyczka, więc `openrouter` zostaje tuż przed
  `opencode`); trasa `POST /api/harness/zai/install` przeniesiona z `harness-versions-routes.js` do `zai-routes.js`; meta w `registry.js`,
  `OPENCODE_/ZAI_/MIMO_HARNESS_PROVIDER` i wpisy w `adapters/index.js` zniknęły. Front: trzy wpisy w `OPTIONAL_HARNESS_LOADERS`
  (osobne chunki panelu i schematu), `harnessModelSettingsPanels.js` / `harnessSettingsSchemas.js` nie wspominają już tych harnessów,
  paczki i18n zostają statyczne. Testy rdzenia, które potrzebują opencode w rejestrach, ładują go przez `tests/helpers/default-optional-harnesses.js`;
  `memory-monitor` / `oom-r17` rejestrują hook przez `loadOptionalProcessLifecycles()`.
- Odwołania we współdzielonym kodzie (inwentarz, przed → po; `refs` / pliki współdzielone): opencode 1705 → 1633 / 275 → 271,
  zai 168 → 151 / 59 → 56, mimo 125 → 122 / 49 → 48. W pięciu composition rootach (`providers`, `backends`, `mcp/adapters/index`,
  `harnessModelSettingsPanels`, `harnessSettingsSchemas`): opencode 40 → 0, zai 35 → 0, mimo 34 → 0. Pliki własne: opencode 56 → 63, zai 14 → 17,
  mimo 12 → 15 (z testami wtyczek). Największe spadki opencode: `harness-versions.js` 16→3, `boot-log.js` 7→0,
  `child-process-registry.js` 11→6, testy polityki zatwierdzeń i `can-use-tool-adapter.js` (neutralne nazwy) ok. −60; nowy współdzielony plik `permission-classifier.js` to 16 odwołań
  (tylko literały `'opencode'` profilu polityki i komentarze). Zostają: `harnessUiRegistry.js`, paczki i18n, mapa `optionalHarnessPanels.js`,
  `sdk-rich-view.js` / `chat.js` (zdarzenia `opencode_*` w UI czatu) i testy rdzenia — dalsza część B2/D1.

**Stan po B2 (punkty wejścia):** 9/9 plików, które importowały wszystkie harnessy,
korzysta z rejestrów. Są 4 composition rooty: `builtin-harness-providers.js` (runtime),
`builtin-harness-backends.js` (status, katalog, ustawienia), `mcp/adapters/index.js`
(MCP, tylko liście) i `app_front/harnessModelSettingsPanels.js` (front). Odwołania
w kodzie współdzielonym: 7 625 → 6 937. Gałęzie po transporcie: 347 → 263.
Pozostałe sprzężenia (UI czatu, `lanSettings.js`, i18n, testy) to dalsza część B2
według listy hotspotów w inwentarzu.
- Rozszerzenie `harness-plugin-contract.js` o hooki: `normalizeEvent`,
  `models`, `settingsSchema`, `authStatus`, `usageMapper`, `planPolicy`.
- `AgentTransport` przestaje być zamkniętą unią: core = literal union,
  plugin = `string` zwalidowany przez rejestr.
- Zamiana ~276 gałęzi na odczyt z rejestru, katalog po katalogu.
  Testy regresji dla każdego transportu zostają zielone.

**B3. Podpięcie loadera i wyprowadzka**
- `harness-plugin-loader.js` wpięty w boot (root pluginów z konfiguracji admina,
  opt-in `enabledIds`, tak jak opisuje kontrakt bezpieczeństwa loadera).
- 8 harnessów → `harnesses/<id>/` z `harness-plugin.json`, origin `builtin-optional`.
- **Decyzja o originie (2026-10-22): nowy origin `builtin-optional`, a nie `local`
  z katalogiem w repo.** Uzasadnienie: (1) `local` ma model zaufania „root od admina,
  kod spoza repo, tylko chat” (lstat/realpath, brak symlinków, opt-in w ustawieniach);
  poluzowanie go pod kod z repo osłabiłoby jedyną granicę bezpieczeństwa loadera,
  a dodanie do niego modeli, MCP i delegacji rozszerzyłoby powierzchnię ataku;
  (2) kod z repo jest zaufany jak reszta repozytorium i musi być statycznie
  rozwiązywalny (webpack, mapa importów we froncie), czego `local` z założenia
  nie obsługuje (ścieżka z konfiguracji, dynamiczny import); (3) osobny origin
  jest odwracalny: usunięcie go z kontraktu nie dotyka wtyczek lokalnych, a loader
  `local` nadal odrzuca go kodem `origin_not_local`; (4) id wbudowanego transportu
  (np. `mistral`) może zostać zajęte tylko przez `builtin-optional`, ids rdzenia
  (`sdk`, `claude`, `codex`, `cursor`) pozostają zarezerwowane zawsze.
- Manifest `builtin-optional` ma osobne wejścia (`entries`): `light` (backend:
  status/katalog/ustawienia oraz adapter MCP; zakaz importu `room-kernel` i modułu
  providerów, taki jak dla `builtin-harness-backends.js` i `mcp/adapters/index.js`),
  `heavy` (runtime providera) i `front` (panel ustawień, wpinany statyczną mapą).
- Front: `*ModelSettings.js` per harness → ekran ustawień renderowany ze `settingsSchema`.
- Testy harnessów idą razem z nimi. CI: job core (zawsze) + job optional (matrix).

**B4. Zgodność danych**
- Chat z transportem wyłączonego pluginu: tryb read-only z komunikatem
  „włącz plugin X”. Historia pozostaje nienaruszona.
- Watcher i `model_pick` nie wybierają wyłączonych harnessów; delegacja do nich
  kończy się `harness_unavailable` zamiast błędem.
- Migracja ustawień: zapisane klucze API nie są kasowane.

**B5. Decyzja końcowa (osobno, później)**
- Które pluginy zostają w repo, a które idą do osobnych repozytoriów lub społeczności.

## 4. Kolejność i zależności

```
A0 ──► A1 ──► A2 ─────────────► A3 ──► A5
        │                        ▲
B1 ──► B2 ──► B3 ──► B4 ─────────┘
              A4 (front) równolegle po A0, poza chat.js (V4)
```

- A0 i B1 można zacząć od razu, są niezależne i nie zmieniają zachowania.
- B2 korzysta z typów z A1 (rejestr capabilities ma typowany kontrakt).
- A3 dopiero po B3, czyli migrujemy tylko kod, który zostaje w rdzeniu.

## 5. Ryzyka

- **Kolizje z ADR-0001**: rename'y w plikach V1/V4/V5 psują merge. Zasada D5.
- **Termux i stary Node**: lokalnie działa Node 20.20, a type stripping wymaga 22.18+.
  Skrypty startowe muszą wymusić właściwą wersję (jak `start-server-node22.sh`).
- **TS 7 (natywny) a JSDoc**: część niuansów JSDoc działa inaczej niż w TS 5.x.
  Baseline robić na tej wersji, którą przypnie CI.
- **Ukryte zależności OpenRouter**: D2 dzieli klienta od harnessu; B1 musi to potwierdzić.

## 6. Proponowane todo (do załadowania do Cretli)

Root: „TS + core harnessy” (sekwencyjnie, `sibling_index` wg kolejności niżej).
1. A0 Fundament typecheck + ratchet w CI
2. B1 Inwentaryzacja sprzężeń harnessów nie-core
3. A1 `@ts-check` na kontraktach (4 podzadania z listy A1)
4. B2 Rejestr capabilities zamiast gałęzi po transporcie
5. A2 Pierwsze pliki `.ts` + `lib/shared-types`
6. B3 Podpięcie loadera, wyprowadzka 8 harnessów do pluginów
7. B4 Zgodność danych dla wyłączonych pluginów
8. A3 Core harnessy w TS (agent-harness, claude, codex, sdk)
9. A4 Front: esbuild-loader + konwersja features
10. A5 `strict` globalnie
