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
