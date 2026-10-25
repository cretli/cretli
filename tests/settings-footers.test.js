/**
 * Settings sticky footers: one data-settings-footer-for mechanism, no per-tab :has() rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { footerMatchesTab, applySettingsFooters } from '../app_front/features/settings/settingsFooters.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function footerSpecs() {
  return [...html.matchAll(/<div class="cr-page-footer"[^>]*data-settings-footer-for="([^"]+)"/g)].map((m) => m[1]);
}

/** Minimal stand-in for the footers in the DOM. */
function fakeRoot(specs) {
  const footers = specs.map((spec) => ({ hidden: true, getAttribute: () => spec }));
  return { footers, querySelectorAll: () => footers };
}

test('footerMatchesTab matches whole tab ids only', () => {
  assert.equal(footerMatchesTab('delegations-limits delegations-review', 'delegations-review'), true);
  assert.equal(footerMatchesTab('execution', 'execution-x'), false);
  assert.equal(footerMatchesTab('', 'workspace'), false);
});

test('applySettingsFooters shows the footer for Workspace, Execution and Connection only', () => {
  const specs = footerSpecs();
  for (const tab of ['workspace', 'execution', 'connection']) {
    const r = fakeRoot(specs);
    applySettingsFooters(r, tab);
    const visible = r.footers.filter((f) => !f.hidden).map((f) => f.getAttribute());
    assert.deepEqual(visible, specs.filter((s) => footerMatchesTab(s, tab)), tab);
    assert.equal(visible.length, 1, tab);
  }
  for (const tab of ['usage', 'account', 'watcher', 'harness']) {
    const r = fakeRoot(specs);
    applySettingsFooters(r, tab);
    assert.equal(r.footers.some((f) => !f.hidden), false, tab);
  }
});

test('footers are siblings of .settings-sections and start hidden', () => {
  const i = html.indexOf('class="settings-sections');
  assert.ok(i > 0);
  const firstFooter = html.indexOf('data-settings-footer-for=');
  assert.ok(firstFooter > i);
  assert.equal([...html.matchAll(/<div class="cr-page-footer"(?![^>]*\bhidden\b)[^>]*>/g)].length, 0);
  for (const id of ['execution-save', 'execution-reset', 'lan-save-btn', 'settings-workspace-apply']) {
    assert.equal(html.split(`id="${id}"`).length, 2, id);
  }
});

test('no per-tab footer :has() rules remain in app_front/css', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', "data-settings-tab='[^']+'.*(cr-page-footer|settings-workspace-save-row|settings-delegation-footer)", '--', 'app_front/css'], { cwd: root, encoding: 'utf8' });
  } catch (_) { /* exit 1 = no match */ }
  assert.equal(out.trim(), '');
});
