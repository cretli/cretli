# UI consistency audit

Inventory of deviations from the shared UI primitives and recipes, per screen,
plus three decisions for a human to approve. **Docs only: this audit changes no
code.** Related: `docs/ui-font-size-tokens.md`, the `cretli-ui` skill
(`.agents/skills/cretli-ui/SKILL.md`).

Measured on 2026-11-07 against the work tree at commit `f801edaa6`. Every number
has a command so it can be repeated.

## 1. Baseline numbers

| # | Metric | Value | Command |
| --- | --- | --- | --- |
| B1 | `settings-section-title` in `public/index.html` | **79** | `rg -o 'settings-section-title' public/index.html \| wc -l` |
| B2 | `settings-section-title` in JS | 2 (`tlsSettings.js:26`, `dataBackupSettings.js:303`) | `rg -n 'settings-section-title' app_front --glob '*.js'` |
| B3 | `cr-section-title` (index.html + `app_front`, all file types) | 24 | `rg -o 'cr-section-title' app_front public/index.html \| wc -l` |
| B4 | Hard `font-size` literals (`rem`/`px`/`em`) in `app_front/css` | **263** | `rg -n 'font-size:\s*[0-9.]+(rem\|px\|em)' app_front/css \| wc -l` |
| B4a | of which legacy layer (`features/chat`, `features/sidebar`, `cr-recipes.scss`) | 6 (all in `cr-recipes.scss`) | `rg -n 'font-size:\s*[0-9.]+(rem\|px\|em)' app_front/css/features/chat app_front/css/features/sidebar app_front/css/cr-recipes.scss` |
| B4b | of which the rest | 257 | `rg -n 'font-size:\s*[0-9.]+(rem\|px\|em)' app_front/css --glob '!features/chat/**' --glob '!features/sidebar/**' --glob '!cr-recipes.scss' \| wc -l` |
| B5 | `font-size` already on a `var(...)` token | 281 | `rg -n 'font-size:\s*var\(' app_front/css \| wc -l` |
| B6 | JS files with a native `<textarea>` / `createElement('textarea')` outside `app_front/components/ui` | **9** (todo cited 10; the 10th was the primitive `cr-bar-textarea.js`) | `rg -l "<textarea\|createElement\(.textarea" app_front --glob '*.js' \| rg -v 'components/ui/' \| wc -l` |
| B7 | JS files with a native `<input>` / `<select>` outside `app_front/components/ui` | **29** (28 without `login/`; todo cited 18, see note) | `rg -l '<(input\|select)\b\|createElement\(.(input\|select).\)' app_front --glob '*.js' \| rg -v 'components/ui/' \| wc -l` |
| B8 | Native `<textarea>` in `public/index.html` | 3 | `rg -c '<textarea' public/index.html` |
| B9 | Native `<input>`/`<select>` in `public/index.html` | 80 | `rg -c '<(input\|select)\b' public/index.html` |
| B10 | `overflow: auto\|scroll` declarations in `app_front/css` | 50 | `rg -n 'overflow(-y)?:\s*(auto\|scroll)' app_front/css \| wc -l` |

Notes:

- B4a is only 6 because the chat/sidebar literals were already moved onto the
  `--cr-font-size-legacy-*` tokens; the legacy layer now shows up in B5 instead.
  The remaining legacy literals: `cr-recipes.scss` lines 72, 79, 143 (`0.8rem`),
  159 (`0.75rem`), 209 (`0.85rem`), 306 (`16px`, intentional, see 2.1).
- B7 differs from the 18 in the todo: the earlier count used a narrower pattern.
  29 uses the pattern above, which includes `createElement` forms. A `--glob
  '!components/ui/**'` exclusion does not match here, so exclusions are done with
  `rg -v 'components/ui/'`.

### Exclusions (what is *not* counted as a deviation)

- `app_front/components/ui/**`: the primitives themselves (`cr-bar-input`,
  `cr-bar-select`, `cr-bar-textarea`, `cr-checkbox`, `cr-searchable-select`,
  `cr-fs-picker`) wrap a native control by design.
- Helper and embed code that never renders a visible field:
  `app_front/lib/clipboard.js` (hidden textarea for the copy fallback),
  `app_front/embed/pageBridge.js` (hidden textarea for the embed clipboard bridge).
- `app_front/login/LoginApp.js`: separate login bundle, 16px root, own styling.
- File inputs, checkboxes, radios and hidden inputs are not "text field"
  deviations; they stay native unless a primitive exists (`cr-checkbox` does).

After excluding the two hidden helpers B6 is 7 user-visible files; the 2.2 table
lists them plus the helpers.

## 2. Per-area findings

### 2.1 Native fields and the mobile rule

`cr-recipes.scss` has two cooperating pieces:

- Opt-in `.cr-form` makes native `input`/`select`/`textarea` look like `cr-bar-*`
  (height, border, `0.8rem`). The selectors (`cr-recipes.scss` ~229-275) cover
  every `.cr-form` descendant; there is no `.cr-field` exclusion. The source
  comment at ~227 ("Never restyles natives under .cr-field") is stale.
- The mobile block at about line 302 (`@media (max-width: 768px)`) sets
  `font-size: 16px` for `select` and `textarea` in `.cr-form` only.
- Text and password inputs are covered by a **separate legacy rule**
  (`app_front/css/features/chat/_send-bar-extra.scss:534`, comment in
  `cr-recipes.scss` near line 227), kept to stop iOS focus zoom.

Gap: `cr-bar-*` primitives stay at `0.8rem` under 768px, so they can trigger the
iOS zoom that `.cr-form` natives avoid. This is Decision 1.

### 2.2 Native textareas (outside the primitive)

| Location | Screen | Decision | Reason |
| --- | --- | --- | --- |
| `app_front/features/settings/executionSettings.js:85` (`#execution-prepare`) | Settings | Migrated (section 6) | Plain multi-line setting in a `.cr-field`; now `cr-bar-textarea` |
| `public/index.html:2531` (`#browser-policy-allowed-origins`) | Settings | Exception, kept native (section 6) | URL list needs `spellcheck=false`, `autocapitalize=off`, `autocomplete=off` and monospace, which `cr-bar-textarea` cannot express |
| `public/index.html:3266` (`#chat-settings-sdk-system-prompt`) | Settings (chat) | Exception, kept native (sections 6-7) | Chat module, outside the Settings leaf; legacy chat layer by owner decision |
| `app_front/features/watcher/scoutProfileEditorView.js:706` | Settings (watcher) | Migrated (section 6) | String-template view; now `cr-bar-textarea` |
| `public/index.html:3172` (`#status-tests-input`, inside `#tests-panel`) | Tests panel | Exception, kept native (sections 6-7) | Dark monospace paste buffer; not a Settings form |
| `app_front/features/decisions/cr-decision-stack.js:165` | Decisions | Migrated (section 7) | Lit view; now `cr-bar-textarea` |
| `app_front/features/initiatives/cr-initiatives-panel.js` (545, 550, 603-605, 661) | Plans | Migrated (section 7) | Lit view; now `cr-bar-textarea` |
| `app_front/features/chat/chatDelegations.js:78` | Chat | Exception for now | Built imperatively inside a dialog and read synchronously; migrate with the chat dialog work |
| `app_front/features/sendBar/views/sendBar.js:76`, `sendBarInput.js:156` | Chat send bar | Exception | The composer: autosize, IME and key handling depend on the raw element |
| `app_front/lib/clipboard.js`, `app_front/embed/pageBridge.js` | Helpers | Exception | Hidden, never user-visible (see exclusions) |

### 2.3 Heading classes

`settings-section-title` appears 79 times in `public/index.html`, almost all in
Settings tabs. `cr-section-title` (small uppercase, `--cr-font-size-xs`) is
already used in Settings views written in JS (`dataBackupSettings.js`,
`networkSettings.js`, `agentPromptsSettings.js`, `mcpOperatorSettings.js`,
`delegationSettings.js`, `autostartSettings.js`), in `apps`, `wakeups` and
`billing`. Result: Settings mixes both on neighbouring tabs, and some tabs show a
subtab bar with the same word repeated as `settings-section-title` right below.

### 2.4 Hard font-size by area (B4 breakdown)

| Area | Count | Command |
| --- | --- | --- |
| `features/settings/_harness.scss` | 49 | `rg -c 'font-size:\s*[0-9.]+(rem\|px\|em)' app_front/css/features/settings` |
| `base/_global.scss` | 34 | idem, path `app_front/css/base` |
| `features/todo/*` | 69 (31 + 21 + 12 + 5) | idem, path `app_front/css/features/todo` |
| `features/git/_git-panel.scss` | 29 | idem, path `app_front/css/features/git` |
| `features/settings/_notifications.scss` | 26 | |
| other settings partials | 15 (diagnostics 14, usage 1) | |
| `features/files`, `browser`, `tasks`, `layout` | 13 + 10 + 4 + 8 | |
| Legacy layer (chat, sidebar, `cr-recipes.scss`) | 6 | see B4a |

### 2.5 Nested scroll containers

`.cr-page` is `overflow: hidden` and `.cr-page-body` is `overflow-y: auto`, both
with `overscroll-behavior: contain`. In Settings, `.settings-sections` is the
single scroller, and `_global.scss:373-376` resets both recipes to
`overflow: visible` / `overscroll-behavior: auto` inside it. That override is a
workaround: tab roots that are `.cr-page` (`#settings-mcp-operator-root`,
`#settings-execution-root`, `#settings-wakeups-section`, which also nests a
`.cr-page-body` at `index.html:2465`) would otherwise swallow touch scroll.
Outside Settings (`index.html:2722` apps page) `.cr-page` + `.cr-page-body` is the
intended single scroller.

## 3. Screen table

| Screen | Deviations | Proposed fix |
| --- | --- | --- |
| Settings | 79 `settings-section-title` in HTML, mixed with `cr-section-title` in JS tabs; ~11 JS files and many HTML fields use native input/select; 4 native textareas (2.2: `executionSettings.js:85`, `index.html:2531`, `index.html:3266`, `scoutProfileEditorView.js:706`); 49+26+15 hard font-sizes in settings partials; nested `.cr-page` reset hack | Decisions 2 and 3; textareas migrated except the documented exceptions (sections 6-7); tokenise settings partials; keep `.settings-sections` the only scroller and stop using `.cr-page` for tab roots |
| Todo | 69 hard font-sizes across 4 partials; 1 JS file with native input/select (`todoDialogs.js`, 3 uses); 0 native textareas | Tokenise todo partials with the new scale; migrate dialog inputs to `cr-bar-input`/`cr-bar-select` |
| Chat | Legacy layer already on tokens (0 literals in `features/chat`, `features/sidebar`); native input/select in `chat/` (3 files); `chatDelegations.js:78` native textarea; send-bar composer native by design | Leave legacy tokens as-is (no visual change); migrate `chatDelegations.js` textarea with the dialog; composer stays an exception |
| Widgets (Settings → Page widgets, `index.html` ~1992-2050) | Heading classes mixed: `settings-section-title` (line 1992) next to `widget-panel-subtitle` (lines 2011, 2045), a third heading style; `_widgets.scss` has no hard font-size (already on `--cr-font-size-*`); `features/widgets` has no native fields | Decision 3: group titles to `cr-section-title`; fold `widget-panel-subtitle` into it or document it as a deliberate sub-level; no font-size work |
| Tests panel (`#tests-panel`, `index.html` ~3140-3172) | Native `#status-tests-input` textarea (`index.html:3172`) | Kept native as a documented exception (sections 6-7) |
| Git | 29 hard font-sizes in `_git-panel.scss`; no native input/select/textarea in `features/git` | Tokenise `_git-panel.scss` with the new scale (needs visual review) |

## 4. Decisions to make

Status of all three: **Decided** by the owner on 2026-11-07 (recommended options chosen).

### Decision 1: field size on mobile

Options: (a) `cr-bar-*` also 16px under 768px (**recommended**); (b) `cr-bar-*`
stays at `0.8rem` and native `.cr-form` fields also drop to `0.8rem` on mobile.
Option (b) means deleting the `.cr-form` mobile block (`cr-recipes.scss` ~302,
`select, textarea { font-size: 16px }`) and the legacy text/password rule
(`app_front/css/features/chat/_send-bar-extra.scss:534`, inside its 768px media
query, `!important`), so no field is forced to 16px on phones.

Recommendation (a). Consequences: removes the iOS focus zoom on all primitives and
makes natives and primitives agree; fields are visibly larger on phones (denser
forms grow taller, may need `cr-bar-*` height to follow). Option (b) keeps the
density and one size everywhere, but every text/password/select/textarea then
triggers the iOS focus zoom, and the legacy rule removal also changes the chat
send-bar and LAN settings inputs it currently covers (`.send-keys-input`,
`.lan-settings-box input`) unless they are re-scoped.

**Decided: (a)**, `cr-bar-*` fields also 16px under 768px, implemented as one
rule. Status: **Decided** (2026-11-07).

### Decision 2: tabs with a subtab bar

Options: (a) pages whose tab already has a subtab bar do not repeat a
`settings-section-title` with the same name (**recommended**); (b) keep the
duplicated title.

Recommendation (a). Consequences: removes redundant headings (part of the 79),
less vertical space on phones; each such tab needs a check that the title carries
no extra hint text that would be lost.

**Decided: (a)**, tabs with a sub-tab bar drop the duplicate
`settings-section-title`. Status: **Decided** (2026-11-07).

Target for the leaf dc3e4435 acceptance ("count of `settings-section-title` in
`public/index.html` after migration"): **Target: 68**.

Rule: a heading is a duplicate only when it consists of nothing but the
harness name plus the sub-tab label it sits under. The firm set is the 11 stats
headings, `<harness> — <harnessSubtabStats>` (`index.html` lines 1818-1920, one per
harness), which repeat the "Stats" sub-tab. 79 − 11 = 68. Headings with their
own wording (e.g. "Cursor SDK — chat models", "DeepSeek API") are kept.

Reproduce:

```
rg -o 'settings-section-title' public/index.html | wc -l                      # 79 before
rg -n 'harnessSubtabStats' public/index.html | rg -c 'settings-section-title' # 11 duplicates
rg -o 'settings-section-title' public/index.html | wc -l                      # must be 68 after
```

If the owner later widens the rule (for example also the "— chat models"
headings), recompute: Target = 79 − number of headings whose text equals the
sub-tab label.

### Decision 3: heading class

Options: (a) `cr-section-title` for in-page groups, `settings-section-title`
only as legacy marker until removed (**recommended**); (b) keep both permanently.

Recommendation (a). Consequences: one heading look across Settings and other
screens; a mechanical rename of up to 79 HTML sites plus 2 JS sites (`tlsSettings.js:26`, `dataBackupSettings.js:303`), with a visual
diff because `cr-section-title` is smaller and uppercase; `settings-section-title`
CSS can be deleted once the count reaches 0.

**Decided: (a)**, `cr-section-title` for in-page groups; `settings-section-title`
legacy only. Status: **Decided** (2026-11-07). The Target 68 above is for the
Decision 2 leaf; the Decision 3 rename later takes the count towards 0.

### Scope of other areas

The owner chose to add migration leaves for Todo, widgets and git as `idea`
children of the root, placed before the Guards leaf (the orchestrator creates
them). They follow the area leaves in section 5.

## 5. Proposed follow-up migration leaves

| Leaf | Scope | Estimate |
| --- | --- | --- |
| Settings textareas to `cr-bar-textarea` | rows marked Migrate in 2.2 for Settings and watcher | 4 files (`executionSettings.js`, `scoutProfileEditorView.js`, `index.html`, tests) |
| Decisions and Plans textareas | `cr-decision-stack.js`, `cr-initiatives-panel.js` | 2 files |
| Settings native input/select to primitives | 11 JS files in `features/settings` plus `index.html` | ~12 files |
| Heading rename (Decisions 2, 3) | `index.html`, `tlsSettings.js`, `dataBackupSettings.js`, CSS cleanup | ~4 files |
| Mobile field size (Decision 1) | `cr-bar-*` components, `cr-recipes.scss` | ~6 files |
| Font-size tokenisation: Settings | `features/settings/*.scss` | 5 files (~90 declarations) |
| Font-size tokenisation: Todo | `features/todo/*.scss` | 4 files (69 declarations) |
| Font-size tokenisation: Git, files, browser, base | `_git-panel`, `_files-tree`, `_browser-panel`, `_global`, layout | ~6 files |
| Settings scroll cleanup | drop `.cr-page` on tab roots, remove `_global.scss:373` hack | ~3 files |
| Remaining native input/select | todo, chat, watcher, wakeups, apps views | ~15 files |

## 6. Settings migration result (2026-11-07, fix round 2)

Textareas (`rg "<textarea|el\('textarea'|createElement\('textarea'" app_front/features/settings public/index.html`):

- Migrated to `cr-bar-textarea` (each passes `aria-label` with the existing translated label, because an outer `<label>` does not reach the shadow DOM): `executionSettings.js` `#execution-prepare`; `scoutProfileEditorView.js` `#watcher-scout-editor-instructions` (component imported in `settings/watcher/scoutEditor.js` to keep the view module pure; monospace carried by `.watcher-form cr-bar-textarea` since the font inherits into the control); `agentPromptsSettings.js` prompt blocks (`readonly` kept); `reviewLessonsSettings.js` edit dialog (the primitive has no `maxlength`, so the 300-character limit is enforced in an `input` listener).
- Native on purpose: `#browser-policy-allowed-origins` (URL list needs `spellcheck=false`, `autocapitalize=off`, `autocomplete=off` and monospace, which `cr-bar-textarea` cannot express); `#chat-settings-sdk-system-prompt` (chat module, outside the Settings leaf); `#status-tests-input` (Tests panel, dark monospace paste buffer).
- Limitation: clicking an outer label does not focus a `cr-bar-textarea`; the accessible name is correct through `aria-label`.

Native input/select in `features/settings` (no blanket claim that they sit in `.cr-form`; they do not):

- Migrated to `cr-bar-input`: the four Execution text fields (`executionSettings.js`) and the lessons globs field (`reviewLessonsSettings.js`).
- Kept native, checkbox/radio/file/range (no `cr-bar-*` equivalent used here): `dataBackupSettings.js` (2 imperative: checkbox, file), `models/harnessSettings.js:190` and `localHarnessPlugins.js:210` (imperative checkboxes), Execution mode radios, `watcher/panelView.js` (17), `watcher/views.js` (1), model settings (3 files, 1 each).
- Kept native, text/number/select, not migrated in this leaf (about 35 sites): `networkSettings.js` 2 selects (Lit templates), `watcher/format.js:68` 1 number, `watcher/views.js:175-187` 1 select + 4 inputs, `watcher/panelView.js` ~27 number/time/text/select, `reviewLessonsSettings.js:193` 1 imperative select. Reason: these need per-screen visual review and change handlers keyed on native events; deferred to a follow-up. Their skin comes from `.watcher-form` / `.cr-form` where present; this was not verified visually.
- Imperative creations remaining in `features/settings`: 5 (`el('input')` x2, `createElement('input')` x2, `el('select')` x1); none is a textarea.

`app_front/css/features/settings/**`: 90 to 0 literal font-size declarations (four legacy tokens added).

## 7. Native fields outside Settings (2026-11-07)

Scope: everything in sections 2.1/2.2/5 outside `features/settings` and `components/ui`. No visual check was possible (no browser verification), so only swaps that keep ids, value reads and events were made. `cr-bar-*` fields carry `aria-label` from `t()` because an outer `<label>` does not reach the shadow DOM; clicking a label does not focus them. Event contract (checked in `cr-bar-input.js` / `cr-bar-textarea.js`): the hosts dispatch only `blur` themselves (`dispatchEvent` at `cr-bar-input.js:119`, `cr-bar-textarea.js:179`). A native `input` event is composed, so it crosses the shadow boundary and a host `@input` handler works; the host's own inner listener runs first, so `host.value` is already synced. A native `change` event is NOT composed and never reaches the host, so do not bind `@change` on `cr-bar-input`/`cr-bar-textarea`; use `@input` or read `host.value` (or `getLiveValue()` on `cr-bar-input`) on the action. `cr-bar-select` is different: it dispatches its own `change` and `cr-change`.

Counts. Two metrics are kept apart: *creation-site lines* are source lines that create a control (comments excluded), measured with `rg -n 'createElement\(.(input|select|textarea).\)|<(input|select|textarea)\b' <file>` and dropping lines that start with `*` or `//`; *controls* are the controls a site produces at run time. Whole-tree line totals (`rg -c` over JS outside `components/ui` and `features/settings`, comments included, so an upper bound): textarea lines 12 -> 5, input/select lines 54 -> 47 (`cr-initiatives-panel.js` 18 -> 7, `todoDialogs.js` 3 -> 1). `public/index.html` is unchanged: 3 textareas, 80 input/select lines (35 of them `type="checkbox"`: `rg '<(select|input)' public/index.html | rg -c 'type="checkbox"'`).

### Migrated

| Item | Result |
| --- | --- |
| `cr-decision-stack.js` "other" reason textarea | `cr-bar-textarea`; card gesture guards now also skip `cr-bar-textarea` (pointer events retarget to the host) |
| `cr-initiatives-panel.js` 6 textareas (text field, list field, research claim/sources/limitations, todo body) | `cr-bar-textarea` |
| `cr-initiatives-panel.js` 5 text/date inputs (map search, title, target date, todo filter, todo dialog title) | `cr-bar-input` (`type="date"` kept via the `type` property) |
| `todoDialogs.js` defer dialog date + reason (`maxLength` 500) | `cr-bar-input` |

### Exceptions

| Item | Count | Reason |
| --- | --- | --- |
| `cr-initiatives-panel.js` selects | 5 | `cr-bar-select` takes an `options` array and fires `cr-change`; the handlers use native `<option>` markup and `.value` binding. Needs a visual pass. |
| `cr-initiatives-panel.js` checkboxes | 2 | No `cr-bar-*` checkbox with the same label layout; `cr-checkbox` swap deferred. |
| `todoDialogs.js` checkbox | 1 | Checkbox, as above. |
| `appsPanel.js` `.apps-ttl` | 1 select | Lit select read via native `@change`; styled by the apps panel CSS. |
| `wakeupsView.js:132,137` | 2 creation-site lines (1 checkbox, 1 number) | String templates read through `[data-wakeup-field]` queries in `wakeupsSettings.js`; number needs `inputmode` (not exposed by `cr-bar-input`). |
| `watcherStatus.js:178`, `watcherDashboard.js:315` | 1 creation site each (1 select each) | Mode select is handled by a delegated `instanceof HTMLSelectElement` check (`watcherPanel.js:373`), the decisions filter by `closest('[data-watcher-decisions-filter]')` (`features/settings/watcher/bindings.js:129`); `widget-panel-select` skin. |
| `scoutFindingsInboxView.js:272`, `scoutHistoryView.js:280`, `scoutProfileEditorView.js` | 1 + 1 + 8 creation-site lines (inbox: one helper emits 3 filter selects; history: 1 select; editor lines 528, 545, 570, 616, 721, 731, 732, 736, several of them helper-generated) | String-template views whose controllers query native `select`/`input`/checkbox by `data-*`/id; the `for=` label association would break against shadow DOM. |
| `harnessModelRoleConfigModel.js` | 11 creation-site lines | Number inputs (`min/max/step`), selects and checkboxes read by `querySelector('[data-field]')` in `harnessModelRoleConfig.js`. |
| `LoginApp.js:417` language select | 1 select | Not a technical blocker: the file already imports `components/ui/index.js` (line 2) and uses `cr-bar-input`. It is a plain two-option select driven by a native `@change` (`_onLangChange`) and a `.value` binding, so it is a candidate for a later `cr-bar-select` swap (event becomes `cr-change`/`change` from the host); left native in this leaf for lack of visual verification. |
| Tests panel `#status-tests-input` + 2 selects (`index.html:3145,3153,3161`) | 1 textarea, 2 selects | Dark monospace paste buffer; guarded by `settings-native-textarea-guard.test.js`. |
| `public/index.html` | 3 textarea, 80 input/select lines (35 checkboxes) | Checkboxes, ranges, number/time and `data-i18n`-bound selects (usage, PWA, wakeups filters, browser policy, files toggles, chat-new modal); not individually re-verified in this leaf. |
| Chat and sidebar legacy layer: textareas `chatDelegations.js:78`, `sendBarInput.js:156`, `views/sendBar.js:76` (3 JS) + `index.html` `#chat-settings-sdk-system-prompt` (1 HTML); other creation sites: `chatDelegations.js:86` checkbox, `sendBarInput.js:146`, `views/sendBar.js:77` (alternative text input), `:90-91` (2 file inputs), `sendBarContextPicker.js:112` (search), `sendBarMedia.js:312` (camera file), `openCodeInteractive.js:118` | 4 textarea controls; 9 other creation-site lines | Legacy layer by owner decision; the composer depends on raw element behaviour. `harnessSettingsLoad.js` only mentions `<select>` in a comment (no creation site). |
| `pageBridge.js:312`, `clipboard.js:13` | 2 textarea (not counted in the chat row) | Hidden helpers, never user-visible. |
