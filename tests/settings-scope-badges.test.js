import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync('public/index.html', 'utf8');
const inventory = fs.readFileSync('docs/settings-scope.md', 'utf8');
const sections = [...html.matchAll(/<section class="settings-section\b[^>]*>[\s\S]*?<\/section>/g)].map(([section]) => section);
const valid = ['global', 'server', 'workspace', 'folder', 'per-item'];

const label = { global: 'Global', server: 'Server', workspace: 'Workspace', folder: 'Folder', 'per-item': 'Per item' };
const scopeOf = (opening) => opening.match(/data-settings-scope="([^"]+)"/)?.[1];
const tabOf = (opening) => opening.match(/data-settings-tab="([^"]+)"/)?.[1];

/** Inventory rows by their leading cell text (first cell starts with `prefix`). */
function inventoryRow(prefix) {
  const rows = inventory.split('\n').filter((line) => line.startsWith(`| ${prefix}`));
  assert.equal(rows.length, 1, `exactly one Inventory row starting with "${prefix}"`);
  const cells = rows[0].split('|').map((cell) => cell.trim());
  return { scope: cells[2], line: rows[0] };
}

/** Every tab of public/index.html -> the Inventory row that documents it. */
const rules = [
  [/^workspace$/, 'per-item', 'Workspace tab: registry list'],
  [/^workspace$/, 'global', 'Workspace tab: Additional Cursor sources'],
  [/^workspace$/, 'workspace', 'Workspace tab: active workspace info'],
  [/^connection/, 'global', 'Connection:'],
  [/^harness.*-approvals$/, 'global', 'Harness → Permissions'],
  [/^harness/, 'global', 'Harness → models, keys, status'],
  [/^interface-browser$/, 'workspace', 'Browser policy'],
  [/^interface-browser$/, 'global', 'External Chrome endpoint'],
  [/^interface-storage$/, 'global', 'Browser storage report'],
  [/^interface/, 'global', 'Interface, voice'],
  [/^chat/, 'global', 'Chat defaults'],
  [/^delegations-prompts$/, 'global', 'Delegations → Prompts'],
  [/^delegations-lessons$/, 'folder', 'Delegations → Lessons'],
  [/^delegations/, 'folder', 'Delegation center, limits'],
  [/^widgets$/, 'per-item', 'Widgets'],
  [/^mcp-clients$/, 'per-item', 'External MCP clients'],
  [/^mcp-operator/, 'folder', 'MCP Operator'],
  [/^mcp$/, 'workspace', 'MCP Servers'],
  [/^execution$/, 'folder', 'Execution'],
  [/^watcher/, 'folder', 'Workspace Watcher policy'],
  [/^usage$/, 'global', 'Usage'],
  [/^wakeups$/, 'global', 'Wake-ups'],
  [/^backups$/, 'global', 'Data and backups'],
  [/^account$/, 'global', 'Account'],
];

test('every Settings section maps to its docs/settings-scope.md Inventory row', () => {
  assert.ok(sections.length > 70);
  const used = new Set();
  for (const section of sections) {
    const opening = section.slice(0, section.indexOf('>'));
    const scope = scopeOf(opening);
    const tab = tabOf(opening);
    assert.ok(valid.includes(scope), opening);
    const rule = rules.find(([re, ruleScope]) => re.test(tab) && ruleScope === scope);
    assert.ok(rule, `no Inventory mapping for tab "${tab}" with scope "${scope}"`);
    used.add(rule[2]);
    const row = inventoryRow(rule[2]);
    assert.ok(row.scope.includes(label[scope]), `Inventory row "${rule[2]}" documents "${row.scope}", markup says ${scope} (tab ${tab})`);
  }
  // Every mapping is exercised, so a removed section cannot leave a stale row behind.
  for (const [, , row] of rules) assert.ok(used.has(row), `Inventory mapping "${row}" matches no section`);
});

test('Delegations subtabs are all covered and nested cards carry a documented scope', () => {
  const tabs = new Set(sections.map((section) => tabOf(section.slice(0, section.indexOf('>')))));
  for (const tab of ['delegations', 'delegations-limits', 'delegations-review', 'delegations-sessions', 'delegations-models', 'delegations-lessons', 'delegations-prompts']) {
    assert.ok(tabs.has(tab), tab);
  }
  for (const [card] of html.matchAll(/<div class="cr-card"[^>]*data-settings-scope="([^"]+)"/g)) {
    const scope = scopeOf(card);
    assert.ok(valid.includes(scope), card);
    assert.ok(inventory.includes(label[scope]), card);
  }
  // Server-flagged delegation fields render in their own Server card (documented in the Delegation row).
  assert.match(fs.readFileSync('app_front/features/settings/delegationSettings.js', 'utf8'), /data-settings-scope="server"/);
  assert.match(inventoryRow('Delegation center, limits').scope, /Server/);
});

test('Settings consumers use the shared runtime scope rather than header DOM', () => {
  function check(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) check(filename);
      else if (entry.name.endsWith('.js')) assert.ok(!fs.readFileSync(filename, 'utf8').includes('header-workspace-trigger'), filename);
    }
  }
  for (const feature of ['settings', 'watcher', 'delegations', 'usage', 'harness-health']) check(`app_front/features/${feature}`);
});
