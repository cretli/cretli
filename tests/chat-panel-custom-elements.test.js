/**
 * The chat panel creates <cr-sdk-mode-bar>, <cr-chat-diag> and
 * <cr-chat-context-panel> by tag name; something in the front bundle must import
 * their modules or the elements stay empty (P4.20 dropped the imports from
 * chat.js on 2026-10-24 and the chat toolbar lost its mode/model bar).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app_front');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['dist', 'node_modules'].includes(e.name)) walk(p); } else if (/\.(js|ts)$/.test(e.name)) files.push(p);
  }
})(root);
const sources = files.map((f) => fs.readFileSync(f, 'utf8'));
for (const [tag, module] of [
  ['cr-sdk-mode-bar', 'cr-sdk-mode-bar.js'],
  ['cr-chat-diag', 'cr-chat-diag.js'],
  ['cr-chat-context-panel', 'cr-chat-context-panel.js'],
]) {
  const imported = sources.some((src) => new RegExp(`import\\s+['"][^'"]*/${module.replace('.', '\\.')}['"]`).test(src));
  assert.ok(imported, `${tag}: no side-effect import of ${module} in app_front/`);
}
console.log('chat-panel-custom-elements.test.js: ok');
