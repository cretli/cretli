# Cretli — instrukcje dla Claude Code

## Todo i zadania

**W tym projekcie todo tworzy się wyłącznie przez Cretli MCP, nie przez `TaskCreate`.**

Zamiast `TaskCreate` używaj:
```
mcp__cretli_bridge__mcp__cretli_builtincretl__todo_create
```

Zamiast `TaskList` / `TaskUpdate` używaj:
```
mcp__cretli_bridge__mcp__cretli_builtincretl__todo_list
mcp__cretli_bridge__mcp__cretli_builtincretl__todo_update
mcp__cretli_bridge__mcp__cretli_builtincretl__todo_show
mcp__cretli_bridge__mcp__cretli_builtincretl__todo_next_ready
```

Dlaczego: zadania tworzone przez `TaskCreate` są widoczne tylko w tym chacie. Cretli todo (`todo_create`) są widoczne w zakładce Todo aplikacji Cretli — dla wszystkich harnessów i użytkownika.

### Reguły tworzenia todo w Cretli

- Zawsze podaj `idempotency_key` — format: `{krótki-slug}-{YYYY-MM-DD}`
- Dla podzadań podaj `parent_id`
- Status: `idea` (szkic), `ready` (do zrobienia), `doing` (w toku), `done`
- Drzewo wykonuje się domyślnie sekwencyjnie według `sibling_index`; `parallel` wymaga jawnego ustawienia. Status rodzica jest wyliczany z dzieci na każdym poziomie: `done` dopiero po wszystkich potomkach. Nie oznaczaj rodzica jako wykonanego, żeby zamknąć nieukończone dzieci; cofnięcie dziecka ponownie otwiera jego przodków.
- `body` — opis co i jak, nie tylko tytuł
- Nie twórz todo dla trywialnych jednorazowych kroków

### Kiedy tworzyć todo

- Gdy użytkownik prosi o plan lub listę zadań
- Gdy podczas pracy odkryjesz powiązane zadania do zrobienia później
- Po zakończeniu pętli multi-harness — opcjonalnie `todo_create` dla otwartych punktów

### Referencja do todo w innym chacie

Linia `cretli-ref todo=<uuid>` to wskaźnik, nie treść zadania. Gdy ją zobaczysz:

```
todo_show({ todo_id: "<uuid>" })
```

Odczyt nie zmienia statusu — status zmieniaj świadomie przez `todo_update`.
`todo_show` i `todo_update` przyjmują też prefiks ID (≥ 8 znaków) rozstrzygany
w workspace wywołującego chatu. Nie mieszaj tego z `cretli-ref chat=<uuid> seq=<n>`
(ten ładuje `chat_event`).

## Podgląd strony — wbudowana przeglądarka Cretli

Do otwarcia, obejrzenia, zrzutu albo debugowania strony (uruchomionej aplikacji
albo samego UI Cretli) używaj wbudowanej przeglądarki przez narzędzia MCP
`browser_*`. Użytkownik widzi tę samą kartę w panelu **Browser**.

```
mcp__cretli_bridge__mcp__cretli_builtincretl__browser_open        { url }
mcp__cretli_bridge__mcp__cretli_builtincretl__browser_screenshot  { browserSessionId, browserTabId }
mcp__cretli_bridge__mcp__cretli_builtincretl__browser_dom / browser_console / browser_network
```

- `browser_open` zwraca `browserSessionId` + `browserTabId` i przejmuje sesję,
  którą użytkownik już otworzył w panelu; `browser_screenshot` zwraca ścieżkę pliku.
- Nie uruchamiaj własnego Playwrighta/Chromium do podglądu i nie szukaj portu
  debugowania ani innego profilu przeglądarki.
- Gdy strona pokazuje logowanie: własny origin Cretli (dostępny tylko przy
  włączonej opcji debugowania `allowSelfOrigin`) loguje się sam przez logowanie
  lokalne bez hasła — nie pytaj użytkownika o dane Cretli; w każdym innym
  przypadku poproś użytkownika o zalogowanie się w panelu Browser tego chatu. Nie
  szukaj haseł, ciasteczek ani tokenów w `.env` i `data/`.
- Błąd `browser_*` mówi, co ma zrobić użytkownik (otworzyć chat w UI, zwolnić
  sesję, dopuścić origin) — przekaż go zamiast obchodzić.

Testy e2e nadal chodzą na projektowych konfiguracjach Playwright. Pełny opis:
skill `cretli-browser` (`.agents/skills/cretli-browser/SKILL.md`).

## Workspace Watcher (autopilot)

Watcher to **deterministyczny strażnik po stronie serwera, bez LLM**, jeden na
workspace. W trybie `autopilot` sam decyduje i startuje **jeden krótkotrwały
chat-orkiestrator na cykl**; tryby `off` i `observe` nie startują żadnego
agenta. Domyślnie `maxParallel = 1`, więc cykle są sekwencyjne.

- **Watcher (serwer, bez LLM) startuje cykl.** Rezerwuje trwałą tożsamość cyklu
  (`cycleId` + `chatId`) i lease, dopisuje slot do `activeCycles` (slot 0
  lustrzany w `activeCycle` dla starszych serwerów), potem CAS-em zajmuje gotowy
  todo (`ready` → `doing` + `claimedByChatId`). Wiersz prowadzi równolegle do
  `policy.maxParallel` cykli (twardy limit 5); kolejny start jest odrzucany
  dopiero przy `activeCycles.length >= maxParallel`.
- **Rodzic cyklu (chat-orkiestrator) wykonuje pętlę plan / implement / review /
  fix** przez `model_pick` + `delegation_start`. To tani rodzic — sam nie
  implementuje pracy, tylko deleguje ją na inne harnessy. Kończy cykl
  wywołaniem **`watcher_report`** (`watcher_update` action `report`)
  z wynikiem `success | blocked | failure`; raport jest idempotentny i przyjmowany
  tylko od orkiestratora danego cyklu. Gdy żyją cykle, autoryzuje wyłącznie
  `chatId` z `activeCycles` — `orchestratorChatId` to tylko „ostatni znany”
  właściciel wiersza bez żywych cykli.
- **Rodzic cyklu nie commituje i nie pushuje** (ani nie robi merge). Nie edytuje
  workspace, gdy trwa review, i nie startuje drugiego implement/fix dopóki
  `slot_occupied=true`.
- **Dzieci nie startują kolejnych delegacji.** Delegacje są jednopoziomowe; tylko
  orkiestrator cyklu wywołuje `delegation_start`.
- **Bramka planu nigdy nie zatwierdza planu sama.** Cykl z niezatwierdzonym
  planem zapisuje szkic i kończy się; `plan.approvedAt` ustawia wyłącznie
  człowiek. Zatwierdzenie planu na przodku (w tym na korzeniu) odblokowuje
  całe poddrzewo — bliższy niezatwierdzony szkic nie trzyma liścia w bramce.
- Sterowanie i podgląd: `watcher_show` / `watcher_update`
  (MCP) oraz Settings → Workspace Watcher. Debugowanie decyzji: `GET
  /api/workspace-watcher/decisions` albo „Why?" w zakładce Todo — pełny opis w
  `docs/workspace-watcher.md`.
- Powiadomienia wynikają z faktycznego stanu w kodzie: `idle_with_work` raz na
  epizod (observe), `blocked` raz na todo, `stopped` raz na zmianę `stopReason`,
  `plan_approval` raz na todo; `observe`/`off` nie startują agentów.
