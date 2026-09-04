import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const webpackDevSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../app_front/webpack.dev.js'),
  'utf8'
);

test('webpack.dev emits async @xterm so the Terminal panel chunk can load', () => {
  // Vendor is initial-only. @xterm is imported only by lazy Terminal/Tasks/Agents
  // panels — without an async cache group those modules are dropped and the tab
  // shows "This panel could not be loaded".
  assert.match(webpackDevSource, /name:\s*['"]xterm['"]/);
  assert.match(webpackDevSource, /node_modules\[\\\\\/\]@xterm/);
  assert.match(webpackDevSource, /!chunk\.canBeInitial\(\)/);
});
