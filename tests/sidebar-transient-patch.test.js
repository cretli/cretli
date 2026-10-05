import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSidebarView } from '../app_front/features/sidebar/sidebarView.js';

const here = dirname(fileURLToPath(import.meta.url));
const viewSource = readFileSync(resolve(here, '../app_front/features/sidebar/sidebarView.js'), 'utf8');

function installLocalStorageStub() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  return map;
}

/** Minimal fake element supporting the attribute/class queries patchTransient uses. */
function makeEl(tag) {
  const attrs = new Map();
  const classes = new Set();
  const el = {
    tag,
    hidden: false,
    textContent: '',
    children: [],
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c); else classes.add(c);
        } else if (force) classes.add(c); else classes.delete(c);
      },
    },
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => attrs.set(n, String(v)),
    toggleAttribute: (n, force) => { if (force) attrs.set(n, ''); else attrs.delete(n); },
    addClass: (c) => classes.add(c),
    _classes: classes,
    _attrs: attrs,
  };
  return el;
}

function matchClasses(el, wanted) {
  return wanted.every((c) => el._classes.has(c));
}

function walk(node, out) {
  for (const child of node.children || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function queryAll(root, selector) {
  // only simple `.a.b` and `.a[attr="v"]` selectors are used by patchTransient
  const attrMatch = /\[data-([\w-]+)="([^"]+)"\]/.exec(selector);
  const cls = selector.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);
  const all = walk(root, []);
  return all.filter((el) => {
    if (!matchClasses(el, cls)) return false;
    if (attrMatch && el.getAttribute(`data-${attrMatch[1]}`) !== attrMatch[2]) return false;
    return true;
  });
}

function makeBody() {
  const body = makeEl('div');
  body.classList.add('sidebar-body');
  return body;
}

function addRow(body, chatId, { active = false, withChip = false } = {}) {
  const li = makeEl('li');
  li.classList.add('sidebar-chat-item');
  if (active) li.classList.add('is-active');
  li.dataset.chatId = chatId;
  li.setAttribute('data-chat-id', chatId);
  if (withChip) {
    const chip = makeEl('span');
    chip.classList.add('sidebar-chat-item-awaiting');
    li.children.push(chip);
    li._chip = chip;
  }
  body.children.push(li);
  return li;
}

function makeView(activeId) {
  return createSidebarView({
    getWorkspaces: () => [],
    getChats: () => [],
    getActiveWorkspaceFile: () => '/w',
    getActiveWorkspaceFolder: () => '/f',
    getActiveChatId: () => activeId,
    getArchivedCounts: () => ({}),
    chatFavorites: { isFavorite: () => false },
    resolveChatState: () => 'idle',
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Idle' }),
    escapeHtml: (v) => String(v ?? ''),
    selectChat: () => {},
    switchWorkspace: () => Promise.resolve(true),
  });
}

function withFakeDocument(view, body) {
  const aside = makeEl('aside');
  aside.children.push(body);
  body._classes.add('sidebar-body');
  const original = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === 'app-sidebar' ? aside : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  // wire the fake body's query methods
  body.querySelectorAll = (sel) => queryAll(body, sel);
  body.querySelector = (sel) => queryAll(body, sel)[0] || null;
  aside.querySelector = (sel) => (sel === '.sidebar-body' ? body : body.querySelector(sel));
  return () => {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  };
}

test('patchTransientVisualStates toggles the active row in place and preserves row + chip nodes', () => {
  installLocalStorageStub();
  const body = makeBody();
  const rowA = addRow(body, 'c1', { active: true, withChip: true });
  const rowB = addRow(body, 'c2', { active: false, withChip: true });
  const chipA = rowA._chip;
  const chipB = rowB._chip;
  const view = makeView('c2');
  const restore = withFakeDocument(view, body);
  try {
    view.patchTransientVisualStates();
    // selection moved from c1 to c2 without replacing any node object
    assert.equal(rowA._classes.has('is-active'), false, 'old active row de-highlighted');
    assert.equal(rowB._classes.has('is-active'), true, 'new active row highlighted');
    assert.equal(rowB.getAttribute('aria-selected'), 'true');
    assert.equal(rowA.getAttribute('aria-selected'), 'false');
    assert.equal(rowA._chip, chipA, 'row A chip node identity preserved (no innerHTML rebuild)');
    assert.equal(rowB._chip, chipB, 'row B chip node identity preserved');
    assert.equal(body.children.length, 2, 'no rows added or removed by the patch');
  } finally {
    restore();
  }
});

test('full render emits the status-patch data attributes so the first patch is a no-op', () => {
  // renderChatItem must emit every attribute applySidebarChatStatusEl compares on,
  // otherwise the first patch after a rebuild would rewrite the chip (restart anim).
  assert.match(viewSource, /data-status-tone=/, 'tone emitted');
  assert.match(viewSource, /data-status-label=/, 'label emitted');
  assert.match(viewSource, /data-activity-key=/, 'activity key emitted');
  assert.match(viewSource, /data-status-outcome=/, 'outcome emitted');
  assert.match(viewSource, /data-visual-key=/, 'row visual key emitted');
  // chatListVisualKey is the exact key the chat.js patch path writes on the row.
  assert.match(viewSource, /import \{[^}]*chatListVisualKey[^}]*\} from '\.\.\/chat\/chatListStateRefresh\.js'/);
});

test('the inert 5s sidebar poll is gone and the status/active marker is out of the signature', () => {
  assert.doesNotMatch(viewSource, /function startPoll\s*\(/, 'startPoll removed');
  assert.doesNotMatch(viewSource, /function stopPoll\s*\(/, 'stopPoll removed');
  assert.doesNotMatch(viewSource, /setInterval\s*\([\s\S]*?,\s*5000\s*\)/, 'no 5s interval');
  // renderSignature must not fold per-chat tone or the active marker into the sig.
  const start = viewSource.indexOf('function renderSignature(partsOut)');
  assert.ok(start >= 0, 'renderSignature located');
  const end = viewSource.indexOf('function patchTransientVisualStates', start);
  assert.ok(end > start, 'renderSignature body bounded by the next helper');
  const sigBody = viewSource.slice(start, end);
  assert.doesNotMatch(sigBody, /statusSig/, 'no status segment in the structural signature');
  assert.doesNotMatch(sigBody, /=== activeChatId \? 'A'/, "no 'A' active marker in the signature");
  assert.doesNotMatch(sigBody, /getTerminalStateMeta/, 'signature does not read chat tone');
});

// ── Scheduler / patcher scope: a per-chat status change must not walk the whole list ─
// `app_front/chat.js` and `app_front/features/chat/chatTransport.js` are browser
// bundles, so (matching the repo convention) the wiring is asserted by source scan.

function sliceFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `located ${signature}`);
  const end = nextSignature ? source.indexOf(nextSignature, start) : -1;
  assert.ok(end > start, `bounded ${signature} by ${nextSignature}`);
  return source.slice(start, end);
}

const chatSource = readFileSync(resolve(here, '../app_front/chat.js'), 'utf8');
const transportSource = readFileSync(
  resolve(here, '../app_front/features/chat/chatTransport.js'),
  'utf8'
);

test('scheduleChatListStateRefresh never marks the whole list dirty from ids', () => {
  const body = sliceFunction(
    chatSource,
    'function scheduleChatListStateRefresh(ids)',
    'export function scheduleChatListStateRefreshAll'
  );
  // No ids, an empty array, and an array without a valid id all bail before planning a frame.
  assert.match(body, /if \(!Array\.isArray\(ids\) \|\| ids\.length === 0\) return;/, 'no/empty array is a no-op');
  assert.match(body, /if \(!added\) return;\s*\n\s*chatListStateRefresh\.schedule\(\);/, 'no valid id => no rAF');
  assert.doesNotMatch(body, /add\('\*'\)/, 'the per-id scheduler never injects the wildcard');
});

test("the wildcard is produced only by scheduleChatListStateRefreshAll (drawer open)", () => {
  const all = sliceFunction(
    chatSource,
    'export function scheduleChatListStateRefreshAll()',
    '/** In-place chat status update'
  );
  assert.match(all, /pendingSidebarDirtyIds\.add\('\*'\);/, 'the wildcard lives in the All variant');
  assert.match(all, /chatListStateRefresh\.schedule\(\);/, 'and plans the frame');
  const occurrences = chatSource.match(/pendingSidebarDirtyIds\.add\('\*'\)/g) || [];
  assert.equal(occurrences.length, 1, 'exactly one place marks the whole list dirty');
  // The drawer-open path (refreshStates -> refreshSidebarChatStates) is the All variant.
  assert.match(
    chatSource,
    /export function refreshSidebarChatStates\(\) \{[\s\S]{0,60}?scheduleChatListStateRefreshAll\(\);/,
    'refreshSidebarChatStates triggers the full patch'
  );
});

test('updateSidebarChatStates ends an empty dirty set before querySelectorAll', () => {
  const body = sliceFunction(
    chatSource,
    'function updateSidebarChatStates(chatById = null)',
    'export function refreshSidebarChatStates'
  );
  const bailIdx = body.indexOf('if (dirty.size === 0) return;');
  const walkIdx = body.indexOf("querySelectorAll('.sidebar-chat-item')");
  assert.ok(bailIdx >= 0, 'empty set ends the patcher');
  assert.ok(walkIdx > bailIdx, 'the full walk only happens after the empty bail');
  assert.doesNotMatch(body, /dirty\.size === 0 \|\| dirty\.has\('\*'\)/, 'empty no longer forces a full patch');
  assert.match(body, /if \(dirty\.has\('\*'\)\)/, 'the full branch is driven only by the wildcard');
});

test('no sidebar call-site still schedules a wildcard with bare parentheses', () => {
  assert.doesNotMatch(
    chatSource,
    /scheduleChatListStateRefresh\(\)/,
    'every refresh is per-id; the only wildcard path is scheduleChatListStateRefreshAll()'
  );
});

test('renderChatTerminalState repaints the active chat own row, per-id', () => {
  const body = sliceFunction(chatSource, 'function renderChatTerminalState(chat', 'function renderChatList()');
  // Early (no bar / not active) branch: per-id, not the wildcard.
  assert.match(body, /scheduleChatListStateRefresh\(chat\?\.id \? \[chat\.id\] : \[\]\);/, 'no-bar branch schedules [chat.id]');
  // Active-with-bar branch now refreshes the row too (was: bar only).
  assert.match(body, /scheduleChatListStateRefresh\(\[chat\.id\]\);[\s\S]*?if \(isPendingHarnessSwitch/, 'active-with-bar schedules the row');
});

test('presence, background-sync and stabilizer callbacks forward chat ids', () => {
  assert.match(chatSource, /onExpire: \(chatId\) => scheduleChatListStateRefresh\(chatId \? \[chatId\] : \[\]\)/, 'stabilizer onExpire passes [chatId]');
  assert.match(chatSource, /onBackgroundSyncComplete: \(ids\) => scheduleChatListStateRefresh\(ids\)/, 'background sync passes ids');
  assert.match(chatSource, /onAgentStatesChange: \(dirtyIds\) => \{[\s\S]{0,60}?scheduleChatListStateRefresh\(dirtyIds\);/, 'agent-states change forwards dirtyIds');
  assert.match(chatSource, /if \(applied\.changed\) scheduleChatListStateRefresh\(applied\.dirtyIds\);/, 'HTTP gap/push-inbox repaint only changed rows');
});

test('performSelectChat dirties prev + next row and drops the full refresh', () => {
  const body = sliceFunction(chatSource, 'function performSelectChat(id)', 'export function loadWorkspaces');
  assert.match(body, /scheduleChatListStateRefresh\(\[prevActiveChatId, id\]\);/, 'selection dirties [prevId, nextId]');
  assert.doesNotMatch(body, /refreshSidebarChatStates\(\)/, 'delegation ack no longer full-refreshes the sidebar');
  assert.match(body, /scheduleChatListStateRefresh\(\[chat\.id\]\);/, 'delegation ack repaints only its chat row');
});

test('syncBackgroundChatConnections reports the rows it actually changed', () => {
  const body = sliceFunction(transportSource, 'function syncBackgroundChatConnections()', 'function scheduleBackgroundSyncCoalesced');
  assert.match(body, /const dirtyBackgroundIds = \[\];/, 'collects changed ids');
  assert.match(body, /chat\._backgroundMonitorMode !== prevMode/, 'mode flip dirties the row');
  assert.match(body, /chat\._connectionStatus !== prevConnection/, 'no-socket disconnect flip dirties the row');
  assert.match(body, /onBackgroundSyncComplete\(dirtyBackgroundIds\);/, 'forwards the id list (empty => no patch)');
  assert.doesNotMatch(body, /onBackgroundSyncComplete\(\);/, 'never calls the old zero-arg completion');
});

test('a visible socket close repaints the row even when reconnect early-returns', () => {
  const body = sliceFunction(transportSource, 'socket.onclose = (event) =>', 'socket.onopen =');
  const reconnectIdx = body.indexOf('scheduleChatReconnect(chat);');
  const renderIdx = body.indexOf('renderChatTerminalState(chat);', reconnectIdx);
  assert.ok(reconnectIdx >= 0, 'visible close schedules a reconnect');
  assert.ok(renderIdx > reconnectIdx, 'and repaints the row directly for the guard-return paths');
});
