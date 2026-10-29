# UI themes

The preference `cretli-theme` holds `system` or a registered theme ID. Legacy
`dark` and `light` values resolve to `cretli-dark` and `cretli-light`. Unknown IDs
fall back to the appearance base (dark for an unknown explicit preference).
`cretli-theme-dark` and `cretli-theme-light` select the matching appearance in
system mode, defaulting to the two Cretli bases.
If a system slot names a theme with the other appearance (including the same ID
in both slots), that slot falls back to its Cretli base in runtime and bootstrap.

Definitions live in `app_front/core/theme/themes/index.js`: `id`, `label`,
`appearance`, `tokens`, `themeColor`, optional `terminal` and `syntax` metadata.
The base themes have empty token deltas, preserving `tokens.scss`. Add a definition
with `registerTheme` before applying its ID. Only `--cr-*` color declarations are
accepted; URLs and arbitrary CSS are discarded. Use tokens for all UI colors.
`terminal` is a partial xterm palette merged over the appearance base by
`getTerminalTheme`; open terminals refresh on `cr-theme-change`. `syntax` keys
(`keyword`, `string`, `comment`, ...) become `--cr-code-<key>` declarations in
`style#cr-theme-vars`, consumed by `.hljs-*`.

`setTheme` persists and applies immediately. `applyTheme` sets `data-theme` to the
appearance and `data-theme-id` to the definition ID, toggles `body.theme-light`,
sets color-scheme and theme-color, and updates `style#cr-theme-vars`. Its selector
uses three `:root` pseudo-classes so color deltas win over the appearance base
even when the bootstrap style precedes the external stylesheet. The event
`cr-theme-change` contains `{ preference, theme, themeId }`; `theme` remains the
appearance for existing terminal listeners. Storage events reapply the preference.

The cache `cretli-theme-cache` stores `{ dark, light }` entries with `themeId`,
`css`, and `themeColor`. The identical early scripts in index, login and offline
pages validate cached declarations and apply them before styles load. Missing,
stale or inaccessible cache falls back to Cretli Dark/Light. The runtime rebuilds
the cache whenever it applies a theme. Backup includes the three preferences,
never the cache. Register a temporary definition in tests to exercise additional
palettes without shipping another theme.

## Built-in themes

Each palette lives in its own file under `app_front/core/theme/themes/` and is
registered by `themes/index.js` through `registerTheme`. Every definition ships
UI token deltas, a full terminal palette (16 ANSI colors, foreground, background,
cursor, cursor accent, selection colors), the complete `syntax` set (14 keys,
emitted as `--cr-code-*`) and `themeColor` (equal to `--cr-bg`).

| Appearance | Themes |
| --- | --- |
| dark | Dracula, One Dark, Nord, Monokai, Solarized Dark, GitHub Dark, Catppuccin Mocha, Gruvbox Dark, Tokyo Night |
| light | Solarized Light, GitHub Light, Catppuccin Latte, Gruvbox Light |

### Semantic mapping

| Token | Source in the palette |
| --- | --- |
| `--cr-bg`, `themeColor`, terminal `background` | editor background |
| `--cr-surface` | sidebar / panel background |
| `--cr-surface-2`, `-raised`, `-inset`, `-code`, `-hover` | blends of background, sidebar and text |
| `--cr-surface-selected`, `-active`, terminal `selectionBackground` | palette selection color |
| `--cr-text`, terminal `foreground` | editor foreground |
| `--cr-text-muted`, `-subtle` | palette comment/gray, nudged toward the text color until contrast is met |
| `--cr-accent`, `--cr-primary`, `--cr-primary-hover` | palette accent; primary is shaded only when `--cr-text-inverse` would fall below 4.5:1 |
| `--cr-error`, `--cr-success`, `--cr-warn` (+ `-bg`, `-border`) | palette red, green, yellow |
| `--cr-link`, `--cr-info` | palette blue/cyan |
| `--cr-border*`, `--cr-control-*`, scrollbars | blends of background and text |
| `syntax.*` | the palette's syntax colors; `bg` is the code surface, `text` the foreground |

Contrast guarantees, enforced per theme by `tests/ui-themes-builtin.test.js`:
`--cr-text` on `--cr-bg` >= 4.5:1, `--cr-text-muted` on `--cr-bg` >= 3:1,
`--cr-text-inverse` on `--cr-primary` >= 4.5:1, and `appearance` matches the
luminance of `--cr-bg`. Where an upstream value missed a threshold (for example
Solarized muted text) it was adjusted slightly, so values may differ from the
upstream spec in those cases.

### Attribution and licenses

Only color values from public palette specifications are used; no logos or
other artwork. Palette names are used descriptively. All palettes are published
under permissive licenses:

- Dracula (MIT, Dracula Theme), One Dark (MIT, Atom One Dark), Nord (MIT, Arctic
  Ice Studio / Sven Greb), Solarized (MIT, Ethan Schoonover), GitHub Dark/Light
  (MIT, Primer), Catppuccin Mocha/Latte (MIT, Catppuccin), Gruvbox (MIT, Pavel
  Pertsev), Tokyo Night (MIT, enkia).
- Monokai: the classic Monokai colors as distributed in the MIT-licensed VS Code
  default themes (original palette by Wimer Hazenberg). The commercial Monokai
  Pro palette is not used.
