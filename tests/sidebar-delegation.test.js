import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { planWorkspaceRebuild } from '../app_front/features/sidebar/sidebarView.js';

/**
 * Leaf 00df6141 items 5 and 6:
 *  - events are delegated to a single `.sidebar-body` listener set
 *    (click / keydown / pointerdown with `closest()`), not re-attached per row;
 *  - a structure change in one workspace swaps only that workspace's `<li>`,
 *    keeping the `<ul class="sidebar-workspaces">` (and its delegated listeners
 *    and scroll position) alive.
 *
 * The module pulls in the whole app graph, so these contracts are pinned against
 * the source the same way the sibling sidebar tests do.
 */

const here = dirname(fileURLToPath(import.meta.url));
const viewSource = readFileSync(resolve(here, '../app_front/features/sidebar/sidebarView.js'), 'utf8');
const archiveFocusSource = readFileSync(
  resolve(here, '../app_front/features/sidebar/sidebarArchiveSidebarFocus.js'),
  'utf8',
);

/**
 * Slice the body of a function declaration out of a source string. Works both
 * for the two-space-indented methods in sidebarView.js and for the top-level
 * `export function` declarations in the archive-focus module.
 */
function sourceFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} located`);
  // Next function declaration (top level or two-space indented) or module end.
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?: {2})?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function functionBody(name) {
  return sourceFunctionBody(viewSource, name);
}

test('row action buttons are emitted as HTML, not built with per-row listeners', () => {
  assert.match(viewSource, /function renderChatActionButtonsHtml\(/, 'action buttons rendered as HTML');
  // The old per-row/per-button wiring created elements and bound listeners.
  assert.doesNotMatch(
    viewSource,
    /document\.createElement\('button'\)/,
    'no per-row button creation in sidebarView.js',
  );
  const wire = functionBody('wireBodyEvents');
  assert.doesNotMatch(wire, /querySelectorAll/, 'wireBodyEvents no longer iterates rows');
  assert.match(wire, /addEventListener\('click', onSidebarBodyClick\)/);
  assert.match(wire, /addEventListener\('keydown', onSidebarBodyKeydown\)/);
  assert.match(wire, /addEventListener\('pointerdown', onSidebarBodyPointerDown, true\)/);
});

test('chat rows still emit the data attributes and action classes the delegated handlers use', () => {
  for (const marker of [
    'sidebar-chat-pin-btn',
    'sidebar-chat-archive-btn',
    'sidebar-chat-restore-btn',
    'sidebar-chat-fav-btn',
    'sidebar-chat-mute-btn',
    'sidebar-chat-action-first',
  ]) {
    assert.match(viewSource, new RegExp(marker), `${marker} emitted from HTML`);
  }
  assert.match(viewSource, /function onSidebarBodyClick\(/);
  assert.match(viewSource, /function onSidebarBodyKeydown\(/);
  assert.match(viewSource, /function onSidebarBodyPointerDown\(/);
  // The settled-subchat group toggles from anywhere on its row, so the dead
  // columns of the wide (grid) layout still activate it.
  assert.match(functionBody('onSidebarBodyClick'), /closest\('\.sidebar-subchat-group-header'\)/);
});

test('keyboard navigation is handled by the delegated keydown listener', () => {
  const keydown = functionBody('onSidebarBodyKeydown');
  assert.match(keydown, /resolveNextItemIndex/);
  assert.match(keydown, /\.click\(\)/);
  // The old per-list listener must be gone.
  assert.doesNotMatch(viewSource, /function initChatListKeyboard\(/);
  // Roving tabindex fallback still runs after a rebuild.
  assert.match(viewSource, /ensureChatListRovingTabindex\(body\)/);
});

test('a workspace structure change rebuilds only the changed <li>, not the whole <ul>', () => {
  assert.match(viewSource, /export function planWorkspaceRebuild\(/);
  assert.match(viewSource, /function reconcileWorkspaceNodes\(/);
  const reconcile = functionBody('reconcileWorkspaceNodes');
  assert.match(reconcile, /renderedWorkspaceNodes\.get\(sidebarKey\)/);
  assert.match(reconcile, /planWorkspaceRebuild\(previousSigs, orderedKeys, opts\.structureByKey\)/);
  assert.match(reconcile, /plan\.reuseKeys\.has\(sidebarKey\)/);
  assert.match(reconcile, /entry\.node\.replaceWith\(node\)/);
  // The `<ul>` is only created when missing; the normal path never rewrites it.
  assert.match(reconcile, /body\.querySelector\('\.sidebar-workspaces'\)/);
  // The main render path must call the reconciler rather than assigning groups HTML.
  const renderBody = functionBody('renderPassBody');
  assert.match(renderBody, /reconcileWorkspaceNodes\(body, visibleWorkspaces/);
  assert.doesNotMatch(renderBody, /groupsHtml/, 'the old whole-list innerHTML build is gone');
  assert.match(viewSource, /function computeWorkspaceStructureSignature\(/);
});

test('partial rebuild preserves scroll position and keyboard focus', () => {
  // renderPassBody captures the focus/scroll snapshot, then asks the scheduler
  // to restore it once the Lit hosts have committed (unsafeHTML is a microtask).
  const renderBody = functionBody('renderPassBody');
  assert.match(renderBody, /const scrollTop = /);
  assert.match(renderBody, /captureSidebarFocusInfo\(body\)/);
  assert.match(renderBody, /scheduleSidebarFocusAndScrollRestore\(body, focusInfo, scrollTop\)/);

  const schedule = functionBody('scheduleSidebarFocusAndScrollRestore');
  assert.match(schedule, /waitForSidebarLitHostsCommit\(body\)/);
  assert.match(schedule, /body\.scrollTop = scrollTop/);
  assert.match(schedule, /restoreSidebarFocus\(body, info\)/);

  // restoreSidebarFocus now lives in the shared archive-focus module.
  const restore = sourceFunctionBody(archiveFocusSource, 'restoreSidebarFocus');
  assert.match(restore, /data-chat-id=/);
  assert.match(restore, /preventScroll: true/);
});

test('planWorkspaceRebuild reuses unchanged workspaces and rebuilds only the changed one', () => {
  const prev = new Map([['a', 's1'], ['b', 's2'], ['c', 's3']]);
  const ordered = ['a', 'b', 'c'];

  const stable = planWorkspaceRebuild(prev, ordered, new Map(prev));
  assert.deepEqual([...stable.reuseKeys].sort(), ['a', 'b', 'c']);
  assert.deepEqual(stable.rebuildKeys, []);
  assert.deepEqual(stable.removeKeys, []);

  const oneChanged = planWorkspaceRebuild(
    prev,
    ordered,
    new Map([['a', 's1'], ['b', 'CHANGED'], ['c', 's3']]),
  );
  assert.deepEqual([...oneChanged.reuseKeys].sort(), ['a', 'c']);
  assert.deepEqual(oneChanged.rebuildKeys, ['b'], 'only workspace b is rebuilt');
  assert.deepEqual(oneChanged.removeKeys, [], 'nothing removed');
});

test('planWorkspaceRebuild adds new workspaces, drops removed ones and keeps order stable', () => {
  const prev = new Map([['a', 's1'], ['b', 's2'], ['c', 's3']]);

  const added = planWorkspaceRebuild(prev, ['a', 'b', 'd'], new Map([['a', 's1'], ['b', 's2'], ['d', 's4']]));
  assert.deepEqual([...added.reuseKeys].sort(), ['a', 'b']);
  assert.deepEqual(added.rebuildKeys, ['d']);
  assert.deepEqual(added.removeKeys, ['c']);

  const reordered = planWorkspaceRebuild(prev, ['c', 'a', 'b'], new Map(prev));
  assert.deepEqual(reordered.rebuildKeys, [], 'reordering alone rebuilds nothing');
  assert.deepEqual([...reordered.reuseKeys].sort(), ['a', 'b', 'c']);
  assert.deepEqual(reordered.removeKeys, []);
});

test('planWorkspaceRebuild treats a missing previous signature as a rebuild', () => {
  const plan = planWorkspaceRebuild(new Map(), ['x'], new Map([['x', 's']]));
  assert.equal(plan.reuseKeys.size, 0);
  assert.deepEqual(plan.rebuildKeys, ['x']);
  assert.deepEqual(plan.removeKeys, []);
});
