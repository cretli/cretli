/**
 * Claude model settings draft contract (Settings → Harness).
 *
 * The panel is real DOM (this suite has no jsdom), so the draft handling is
 * asserted from source the same way the other settings UI tests do: checkbox
 * changes and select/deselect-all may only touch the rows they act on, never
 * rebuild the enabled set from what happens to be rendered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app_front/claudeModelSettings.js'), 'utf8');

function functionBody(name) {
  const match = source.match(new RegExp(`function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${name} is missing`);
  return match[1];
}

test('reading checkboxes updates only the rows that are rendered', () => {
  const body = functionBody('readDraftEnabledKeysFromUi');
  assert.doesNotMatch(body, /draftEnabledKeys = /);
  assert.match(body, /draftEnabledKeys\.delete\(value\)/);
});

test('select-all and deselect-all change only catalog rows', () => {
  const body = functionBody('toggleAllCatalogModelSettings');
  assert.doesNotMatch(body, /setDraftEnabledKeys/);
});
