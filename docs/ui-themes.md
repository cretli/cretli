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
