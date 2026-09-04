import assert from 'node:assert/strict';
import {
  collectUiBlockerSnapshot,
  diffUiBlockerSnapshot,
  describeUiElement,
  isUiFreezeDiagnosticsEnabled,
  snapshotFingerprint,
} from '../app_front/lib/pwaFreezeDiagnostics.js';

assert.equal(isUiFreezeDiagnosticsEnabled(), false);

function createDoc() {
  const bodyClasses = new Set();
  return {
    visibilityState: 'visible',
    body: {
      classList: {
        contains(name) {
          return bodyClasses.has(name);
        },
        [Symbol.iterator]() {
          return bodyClasses[Symbol.iterator]();
        },
      },
      style: { overflow: '', touchAction: '', overscrollBehavior: '' },
    },
    documentElement: {
      style: { overflow: '', overscrollBehavior: '' },
    },
    getElementById(id) {
      if (id === 'chat-reconnect-modal') return this._chatReconnectModal || null;
      if (id === 'connection-status-dialog') return this._connectionStatusDialog || null;
      if (id === 'app-sidebar') return { hidden: true };
      if (id === 'app-sidebar-backdrop') return { hidden: true };
      if (id === 'kib-radial-layer') return this._kibLayer || null;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    elementFromPoint() {
      return { tagName: 'DIV', id: 'chat-panel', className: 'active' };
    },
    _chatReconnectModal: null,
    _connectionStatusDialog: null,
    _kibLayer: null,
    _bodyClasses: bodyClasses,
  };
}

assert.deepEqual(describeUiElement(null), null);
assert.equal(describeUiElement({ nodeType: 1, tagName: 'DIV', id: 'x', className: 'a' }).id, 'x');

const baseDoc = createDoc();
const baseSnapshot = collectUiBlockerSnapshot(baseDoc, 'test');
assert.equal(baseSnapshot.openModals.length, 0);

const modalDoc = createDoc();
modalDoc._chatReconnectModal = { hidden: false };
const modalSnapshot = collectUiBlockerSnapshot(modalDoc, 'modal');
assert.deepEqual(modalSnapshot.openModals, ['chat-reconnect-modal']);

const closedDialogDoc = createDoc();
closedDialogDoc._connectionStatusDialog = { open: false, hidden: false };
const closedDialogSnapshot = collectUiBlockerSnapshot(closedDialogDoc, 'dialog-closed');
assert.deepEqual(closedDialogSnapshot.openModals, []);

const openDialogDoc = createDoc();
openDialogDoc._connectionStatusDialog = { open: true, hidden: false };
const openDialogSnapshot = collectUiBlockerSnapshot(openDialogDoc, 'dialog-open');
assert.deepEqual(openDialogSnapshot.openModals, ['connection-status-dialog']);

const changes = diffUiBlockerSnapshot(baseSnapshot, modalSnapshot);
assert.ok(changes.includes('modal+:chat-reconnect-modal'));

assert.notEqual(snapshotFingerprint(baseSnapshot), snapshotFingerprint(modalSnapshot));

console.log('pwa-freeze-diagnostics.test.js: ok');
