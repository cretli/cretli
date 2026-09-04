import assert from 'node:assert/strict';
import {
  closeStrayFloatingMenus,
  hasBlockingModalOpen,
  reconcileSidebarBackdrop,
  releaseStuckPageScrollLock,
} from '../app_front/lib/pageResumeCleanup.js';

function createDoc() {
  return {
    querySelector(selector) {
      if (selector.includes('chat-reconnect-modal')) return this._chatModal || null;
      if (selector.includes('tasks-reconnect-modal')) return this._tasksModal || null;
      if (selector.includes('restart-server-loading-modal')) return this._restartModal || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('chat-list-modal')) return this._floatingMenus || [];
      if (selector.includes('files-root-dropdown')) return [];
      return [];
    },
    getElementById(id) {
      if (id === 'app-sidebar') return this._sidebar || null;
      if (id === 'app-sidebar-backdrop') return this._backdrop || null;
      if (id === 'kib-radial-layer') return this._kibLayer || null;
      return null;
    },
    documentElement: {
      style: { overflow: '', overscrollBehavior: '' },
    },
    body: {
      classList: {
        _classes: new Set(),
        contains(name) {
          return this._classes.has(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
      style: { overflow: '', overscrollBehavior: '', touchAction: '' },
    },
    _sidebar: null,
    _backdrop: null,
    _chatModal: null,
    _tasksModal: null,
    _restartModal: null,
    _kibLayer: null,
    _floatingMenus: [],
  };
}

assert.equal(hasBlockingModalOpen(createDoc()), false);

const modalDoc = createDoc();
modalDoc._chatModal = { hidden: false };
assert.equal(hasBlockingModalOpen(modalDoc), true);

const sidebarDoc = createDoc();
sidebarDoc._sidebar = { hidden: true };
sidebarDoc._backdrop = { hidden: false };
assert.equal(reconcileSidebarBackdrop(sidebarDoc), true);
assert.equal(sidebarDoc._backdrop.hidden, true);
assert.equal(sidebarDoc.body.classList.contains('sidebar-open'), false);

const sidebarClassDoc = createDoc();
sidebarClassDoc._sidebar = { hidden: true };
sidebarClassDoc.body.classList._classes.add('sidebar-open');
assert.equal(reconcileSidebarBackdrop(sidebarClassDoc), true);
assert.equal(sidebarClassDoc.body.classList.contains('sidebar-open'), false);

const openSidebarDoc = createDoc();
openSidebarDoc._sidebar = { hidden: false };
openSidebarDoc._backdrop = { hidden: false };
assert.equal(reconcileSidebarBackdrop(openSidebarDoc), false);

const scrollDoc = createDoc();
scrollDoc.documentElement.style.overflow = 'hidden';
assert.equal(releaseStuckPageScrollLock(scrollDoc), true);
assert.equal(scrollDoc.documentElement.style.overflow, '');

const staleKibDoc = createDoc();
staleKibDoc.body.classList._classes.add('kib-radial-active');
staleKibDoc.body.style.overflow = 'hidden';
staleKibDoc.body.style.touchAction = 'none';
assert.equal(releaseStuckPageScrollLock(staleKibDoc), true);
assert.equal(staleKibDoc.body.classList.contains('kib-radial-active'), false);
assert.equal(staleKibDoc.body.style.touchAction, '');

const kibLockedDoc = createDoc();
kibLockedDoc.body.classList._classes.add('kib-radial-active');
kibLockedDoc._kibLayer = { classList: { contains: () => true } };
kibLockedDoc.body.style.overflow = 'hidden';
assert.equal(releaseStuckPageScrollLock(kibLockedDoc), false);

const floatingMenuDoc = createDoc();
const menu = { hidden: false, style: { left: '10px', top: '20px', minWidth: '1px', maxWidth: '2px', maxHeight: '3px' } };
floatingMenuDoc._floatingMenus = [menu];
assert.equal(closeStrayFloatingMenus(floatingMenuDoc), true);
assert.equal(menu.hidden, true);
assert.equal(menu.style.left, '');

console.log('page-resume-cleanup.test.js: ok');
