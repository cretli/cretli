import { readFileSync } from 'node:fs';

/**
 * The Todo panel is split across `app_front/features/todo/views/todoPanel.js` and the modules
 * below. Source-level tests read them as one text; the state module comes first
 * so the concatenation also works as a single script in a vm context.
 */
const PANEL_FILES = [
  'features/todo/state/todoPanelState.js',
  'features/todo/services/todoPanelContext.js',
  'features/todo/views/todoToolbar.js',
  'features/todo/views/todoBatchView.js',
  'features/todo/services/todoBatchFlow.js',
  'features/todo/services/todoCardActions.js',
  'features/todo/services/todoDetail.js',
  'features/todo/views/todoListRender.js',
  'features/todo/views/todoRowMenu.js',
  'features/todo/views/todoRowRender.js',
  'features/todo/services/todoRowInteractions.js',
  'features/todo/views/todoEditor.js',
  'features/todo/services/todoAgentStart.js',
  'features/todo/services/todoFieldHandlers.js',
  'features/todo/services/todoListRefresh.js',
  'features/todo/views/todoPanel.js',
];

/** @returns {string} raw source of the whole Todo panel (imports and exports intact) */
export function readTodoPanelSource() {
  return PANEL_FILES
    .map((file) => readFileSync(new URL(`../../app_front/${file}`, import.meta.url), 'utf8'))
    .join('\n');
}

/** @returns {string} the panel as one script: module syntax removed */
export function readTodoPanelScript() {
  return readTodoPanelSource()
    .replace(/^import\b[\s\S]*?;\s*/gm, '')
    .replace(/^export \{[\s\S]*?\} from [^;]*;\s*/gm, '')
    .replace(/^export /gm, '');
}
