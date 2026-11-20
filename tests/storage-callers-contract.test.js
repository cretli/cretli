import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndValidateStorageRegistry } from '../lib/storage/validate-storage-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'storage-callers.md');

/** Allowed future-owner slices; `stays-file` additionally needs a reason. */
const ALLOWED_OWNERS = Object.freeze(['A3a', 'A3b', 'A4', 'A5', 'A6', 'B4']);
const CALLER_SECTION = /^## (HTTP routes|WebSocket|Background timers|MCP tools|Subprocess)/;

/**
 * Parse the caller tables (sections whose heading matches CALLER_SECTION).
 *
 * @param {string} markdown
 * @returns {Array<{ section: string, storeId: string, owner: string | undefined, line: number }>}
 */
function parseCallerRows(markdown) {
  const rows = [];
  let section = '';
  let ownerColumn = -1;
  markdown.split('\n').forEach((line, index) => {
    if (line.startsWith('## ')) {
      section = CALLER_SECTION.test(line) ? line : '';
      ownerColumn = -1;
      return;
    }
    if (!section || !line.startsWith('|')) return;
    const cells = line.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim());
    if (cells[0] === 'Store id') {
      ownerColumn = cells.findIndex((c) => c.toLowerCase() === 'owner');
      return;
    }
    if (/^-+$/.test(cells[0])) return;
    rows.push({
      section,
      storeId: cells[0],
      owner: ownerColumn >= 0 ? cells[ownerColumn] : undefined,
      line: index + 1,
    });
  });
  return rows;
}

/**
 * @param {string | undefined} owner
 * @returns {boolean}
 */
function isValidOwner(owner) {
  if (!owner) return false;
  if (ALLOWED_OWNERS.includes(owner)) return true;
  const match = /^stays-file: (.+)$/.exec(owner);
  return Boolean(match && match[1].trim().length >= 5);
}

/** Export boundaries that keep a store out of ordinary export/backup. */
const CREDENTIAL_BOUNDARIES = Object.freeze(['credential-boundary', 'never-in-app-data-export']);

/**
 * Whether the registry says the store deliberately stays a file.
 *
 * @param {{ adapters: { migration: string }, secrets: { exportBoundary: string } }} store
 * @returns {boolean}
 */
function mustStayFile(store) {
  const migration = store.adapters.migration;
  return migration === 'none' || migration.startsWith('retain') || CREDENTIAL_BOUNDARIES.includes(store.secrets.exportBoundary);
}

/**
 * Validate parsed caller rows against a registry; returns human-readable problems.
 *
 * @param {ReturnType<typeof parseCallerRows>} rows
 * @param {{ stores: Array<any> }} registry
 * @returns {string[]}
 */
function validateCallerRows(rows, registry) {
  const problems = [];
  const stores = new Map(registry.stores.map((s) => [s.id, s]));
  const owners = new Map();
  for (const row of rows) {
    if (!isValidOwner(row.owner)) problems.push(`line ${row.line}: ${row.storeId} has invalid owner ${String(row.owner)}`);
    if (row.storeId === '—') continue;
    if (owners.has(row.storeId) && owners.get(row.storeId) !== row.owner) problems.push(`${row.storeId} has conflicting owners`);
    owners.set(row.storeId, row.owner);
    const store = stores.get(row.storeId);
    if (!store) {
      problems.push(`${row.storeId} is not in the registry`);
      continue;
    }
    const staysFile = String(row.owner).startsWith('stays-file');
    if (mustStayFile(store) && !staysFile) problems.push(`${row.storeId} must be stays-file (migration ${store.adapters.migration}, boundary ${store.secrets.exportBoundary}) but is ${row.owner}`);
    if (store.adapters.migration.startsWith('planned-') && staysFile) problems.push(`${row.storeId} has a planned domain (${store.adapters.migration}) and must not be stays-file`);
  }
  for (const id of stores.keys()) if (!owners.has(id)) problems.push(`registry store ${id} missing from the doc`);
  return problems;
}

describe('storage callers doc contract (A1/A2 S8)', () => {
  const markdown = fs.readFileSync(DOC, 'utf8');
  const rows = parseCallerRows(markdown);
  const loaded = loadAndValidateStorageRegistry();
  const registry = loaded.ok ? loaded.registry : { stores: [] };

  it('loads the registry and parses caller rows from all five caller tables', () => {
    assert.equal(loaded.ok, true);
    assert.ok(rows.length >= 40, `expected >= 40 caller rows, got ${rows.length}`);
    assert.equal(new Set(rows.map((r) => r.section)).size, 5);
  });

  it('owners are valid, consistent per store and agree with the registry', () => {
    assert.deepEqual(validateCallerRows(rows, registry), []);
  });

  it('pins the credential and mixed-domain stores', () => {
    const ownerOf = (id) => rows.find((r) => r.storeId === id)?.owner;
    assert.match(ownerOf('store.auth-sessions'), /^stays-file: /);
    assert.match(ownerOf('store.push-subscriptions'), /^stays-file: /);
    assert.equal(ownerOf('store.mcp-config'), 'A5');
  });

  it('does not attribute slice labels to persistence-design (they are defined in the doc legend)', () => {
    assert.doesNotMatch(markdown, /persistence-design\.md[^\n]*Migration and rollout/);
    assert.match(markdown, /`A3a` chat history/);
  });

  describe('negative checks (validator fails on mutated copies)', () => {
    const clone = () => rows.map((r) => ({ ...r }));
    const mutate = (storeId, owner) => clone().map((r) => (r.storeId === storeId ? { ...r, owner } : r));

    it('rejects a missing owner and an unknown owner', () => {
      assert.ok(validateCallerRows(mutate('store.todos', ''), registry).some((p) => /invalid owner/.test(p)));
      assert.ok(validateCallerRows(mutate('store.todos', 'A9'), registry).some((p) => /invalid owner/.test(p)));
      assert.ok(validateCallerRows(mutate('store.todos', 'stays-file'), registry).some((p) => /invalid owner/.test(p)));
    });

    it('rejects a credential / migration-none store owned by A5', () => {
      assert.ok(validateCallerRows(mutate('store.auth-sessions', 'A5'), registry).some((p) => /store\.auth-sessions must be stays-file/.test(p)));
      assert.ok(validateCallerRows(mutate('store.push-subscriptions', 'A5'), registry).some((p) => /store\.push-subscriptions must be stays-file/.test(p)));
    });

    it('rejects a planned-domain store marked stays-file', () => {
      assert.ok(validateCallerRows(mutate('store.mcp-config', 'stays-file: because'), registry).some((p) => /must not be stays-file/.test(p)));
    });

    it('rejects id-set drift in both directions and conflicting owners', () => {
      const extra = [...clone(), { section: 'x', storeId: 'store.not-in-registry', owner: 'A5', line: 1 }];
      assert.ok(validateCallerRows(extra, registry).some((p) => /not in the registry/.test(p)));
      const dropped = clone().filter((r) => r.storeId !== 'store.sidebar-layout');
      assert.ok(validateCallerRows(dropped, registry).some((p) => /store\.sidebar-layout missing/.test(p)));
      const conflict = clone();
      const idx = conflict.findIndex((r) => r.storeId === 'store.todos');
      conflict[idx] = { ...conflict[idx], owner: 'A5' };
      assert.ok(validateCallerRows(conflict, registry).some((p) => /conflicting owners/.test(p)));
    });

    it('parser reports an absent owner column', () => {
      const noColumn = parseCallerRows('## HTTP routes\n\n| Store id | Module |\n| --- | --- |\n| store.x | m |\n');
      assert.equal(noColumn[0].owner, undefined);
      assert.equal(isValidOwner('stays-file: kept as journal'), true);
    });
  });
});
