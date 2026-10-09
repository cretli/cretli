import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySidebarChatStatusEl,
  isIconOnlySidebarStatus,
  renderSidebarChatStatusHtml,
} from '../app_front/features/sidebar/sidebarChatStatus.js';

/**
 * Minimal chip double with an icon node and an activity-label node so a test can
 * prove the icon node survives a label-only update.
 */
function makeChipEl({ tone, activityKey = '', label = '' }) {
  const attrs = new Map();
  const iconNode = { className: 'mdi mdi-cog-outline mdi-spin', textContent: '' };
  const labelNode = { className: 'sidebar-chat-item-activity-label', textContent: '', hidden: false };
  const el = {
    hidden: false,
    className: 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--' + tone,
    innerHTML: '',
    _iconNode: iconNode,
    _labelNode: labelNode,
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    querySelector(selector) {
      if (selector === '.sidebar-chat-item-activity-label') return labelNode;
      if (selector === '.mdi') return iconNode;
      return null;
    },
  };
  el.setAttribute('data-status-tone', tone);
  el.setAttribute('data-activity-key', activityKey);
  el.setAttribute('data-status-label', label);
  el.setAttribute('data-status-outcome', '');
  labelNode.textContent = activityKey ? label : '';
  return el;
}

test('isIconOnlySidebarStatus covers disconnected, connecting, active and needs-action', () => {
  assert.equal(isIconOnlySidebarStatus('disconnected'), true);
  assert.equal(isIconOnlySidebarStatus('connecting'), true);
  assert.equal(isIconOnlySidebarStatus('syncing'), true);
  assert.equal(isIconOnlySidebarStatus('active'), true);
  assert.equal(isIconOnlySidebarStatus('awaiting'), true);
  assert.equal(isIconOnlySidebarStatus('idle'), false);
  assert.equal(isIconOnlySidebarStatus('attention'), false);
});

test('renderSidebarChatStatusHtml uses a broken-chain icon when disconnected', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'disconnected', label: 'Disconnected' },
    (value) => value
  );
  assert.match(actual, /mdi-link-variant-off/);
  assert.equal(actual.includes('Disconnected'), false);
});

test('renderSidebarChatStatusHtml uses a spinner icon when connecting', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'connecting', label: 'Connecting…' },
    (value) => `esc:${value}`
  );
  assert.match(actual, /mdi-loading/);
  assert.match(actual, /mdi-spin/);
  assert.equal(actual.includes('Connecting'), false);
});

test('renderSidebarChatStatusHtml uses an animated sync icon while syncing messages', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'syncing', label: 'Synchronizacja wiadomości…' },
    (value) => value
  );
  assert.match(actual, /mdi-sync/);
  assert.match(actual, /mdi-spin/);
  assert.equal(actual.includes('Synchronizacja'), false);
});

test('applySidebarChatStatusEl does not rewrite markup when the tone is unchanged', () => {
  const el = {
    hidden: false,
    className: 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--connecting',
    innerHTML: '<span class="mdi mdi-loading mdi-spin" aria-hidden="true"></span>',
    attrs: {
      'data-status-tone': 'connecting',
      'data-activity-key': '',
      'data-status-label': 'Connecting…',
      title: 'old',
    },
    getAttribute(name) {
      return this.attrs[name] || '';
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
  };
  const rewritten = applySidebarChatStatusEl(
    el,
    { tone: 'connecting', label: 'Connecting…' },
    { title: 'State: Connecting…' }
  );
  assert.equal(rewritten, false);
  assert.match(el.innerHTML, /mdi-spin/);
  assert.equal(el.attrs.title, 'State: Connecting…');
});

test('applySidebarChatStatusEl rewrites markup when the tone changes', () => {
  const el = {
    hidden: false,
    className: 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--connecting',
    innerHTML: '<span class="mdi mdi-loading mdi-spin" aria-hidden="true"></span>',
    attrs: { 'data-status-tone': 'connecting' },
    getAttribute(name) {
      return this.attrs[name] || '';
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
  };
  const rewritten = applySidebarChatStatusEl(el, { tone: 'disconnected', label: 'Disconnected' });
  assert.equal(rewritten, true);
  assert.match(el.innerHTML, /mdi-link-variant-off/);
  assert.equal(el.attrs['data-status-tone'], 'disconnected');
});

test('renderSidebarChatStatusHtml uses a spinning cog when the agent is working', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'active', label: 'Agent working' },
    (value) => value
  );
  assert.match(actual, /mdi-cog-outline/);
  assert.match(actual, /mdi-spin/);
  assert.equal(actual.includes('Agent working'), false);
});

test('renderSidebarChatStatusHtml uses an alert icon when action is needed', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'awaiting', label: 'Needs action' },
    (value) => `esc:${value}`
  );
  assert.match(actual, /mdi-alert-circle-outline/);
  assert.equal(actual.includes('Needs action'), false);
});

test('renderSidebarChatStatusHtml shows the icon plus activity text when the agent has a tool', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'active', label: 'Read a.js', activityKey: 'read' },
    (value) => `esc:${value}`
  );
  assert.match(actual, /mdi-cog-outline/);
  assert.match(actual, /mdi-spin/);
  assert.match(actual, /sidebar-chat-item-activity-label/);
  assert.match(actual, /esc:Read a\.js/);
});

test('applySidebarChatStatusEl keeps the icon node when only the activity label changes', () => {
  const el = makeChipEl({ tone: 'active', activityKey: 'read', label: 'Read a.js' });
  const iconNode = el._iconNode;
  const rewritten = applySidebarChatStatusEl(
    el,
    { tone: 'active', label: 'Grep y', activityKey: 'grep' },
    { escapeHtml: (value) => value }
  );
  assert.equal(rewritten, true);
  assert.equal(el._iconNode, iconNode, 'icon node identity preserved (spinner keeps running)');
  assert.equal(el._labelNode.textContent, 'Grep y', 'label updated through textContent');
  assert.equal(el.innerHTML, '', 'markup was not rewritten');
  assert.equal(el.getAttribute('data-activity-key'), 'grep');
});

test('applySidebarChatStatusEl clears the label when the generic working state returns', () => {
  const el = makeChipEl({ tone: 'active', activityKey: 'read', label: 'Read a.js' });
  const iconNode = el._iconNode;
  applySidebarChatStatusEl(el, { tone: 'active', label: 'Agent working' }, { escapeHtml: (value) => value });
  assert.equal(el._iconNode, iconNode);
  assert.equal(el._labelNode.textContent, '');
  assert.equal(el.getAttribute('data-activity-key'), '');
});

test('applySidebarChatStatusEl appends the activity label without replacing an icon-only chip', () => {
  const attrs = new Map();
  const iconNode = { className: 'mdi mdi-cog-outline mdi-spin' };
  const children = [iconNode];
  const el = {
    hidden: false,
    className: 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--active',
    innerHTML: '',
    ownerDocument: {
      createElement: () => ({ className: '', textContent: '' }),
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    querySelector() {
      return null;
    },
    appendChild(node) {
      children.push(node);
      return node;
    },
  };
  el.setAttribute('data-status-tone', 'active');
  el.setAttribute('data-activity-key', '');
  el.setAttribute('data-status-label', 'Agent working');
  el.setAttribute('data-status-outcome', '');
  applySidebarChatStatusEl(el, { tone: 'active', label: 'Read a.js', activityKey: 'read' });
  assert.equal(children[0], iconNode, 'icon node preserved');
  assert.equal(children[1].className, 'sidebar-chat-item-activity-label');
  assert.equal(children[1].textContent, 'Read a.js');
  assert.equal(el.innerHTML, '', 'markup was not rewritten');
});

test('renderSidebarChatStatusHtml uses outcome icons for settled delegation states', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'attention', label: 'Completed', status: 'completed' },
    (value) => `esc:${value}`
  );
  assert.match(actual, /mdi-check-circle-outline/);
  assert.equal(actual.includes('Completed'), false);
  assert.match(renderSidebarChatStatusHtml({ tone: 'attention', status: 'failed' }), /mdi-alert-outline/);
  assert.match(renderSidebarChatStatusHtml({ tone: 'attention', status: 'interrupted' }), /mdi-pause-circle-outline/);
  assert.match(renderSidebarChatStatusHtml({ tone: 'attention', status: 'cancelled' }), /mdi-close-circle-outline/);
});

test('attention status is icon-only when it represents a settled delegation outcome', () => {
  assert.equal(isIconOnlySidebarStatus('attention', { status: 'completed' }), true);
  assert.equal(isIconOnlySidebarStatus('attention', { status: 'failed' }), true);
  assert.equal(isIconOnlySidebarStatus('attention', { label: 'Needs attention' }), false);
});

test('renderSidebarChatStatusHtml shows the archive countdown with a clock icon', () => {
  const soon = renderSidebarChatStatusHtml({ tone: 'archive-soon', label: '2d' }, (v) => v);
  assert.match(soon, /mdi-progress-clock/);
  assert.match(soon, /sidebar-chat-item-activity-label/);
  assert.match(soon, />2d</);
  const imminent = renderSidebarChatStatusHtml({ tone: 'archive-imminent', label: '30m' }, (v) => v);
  assert.match(imminent, /mdi-progress-clock/);
  assert.match(imminent, />30m</);
});

test('applySidebarChatStatusEl updates the countdown label without rebuilding the icon', () => {
  const el = makeChipEl({ tone: 'archive-soon', activityKey: '', label: '2d' });
  const iconNode = el._iconNode;
  const rewritten = applySidebarChatStatusEl(
    el,
    { tone: 'archive-soon', label: '1d' },
    { escapeHtml: (value) => value }
  );
  assert.equal(rewritten, true);
  assert.equal(el._iconNode, iconNode, 'icon node identity preserved (animation keeps running)');
  assert.equal(el._labelNode.textContent, '1d');
  assert.equal(el.innerHTML, '', 'markup was not rewritten');
  assert.equal(el.getAttribute('data-status-label'), '1d');
  assert.equal(isIconOnlySidebarStatus('archive-soon'), false);
  assert.equal(isIconOnlySidebarStatus('archive-imminent'), false);
});
