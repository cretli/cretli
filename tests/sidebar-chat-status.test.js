import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySidebarChatStatusEl,
  isIconOnlySidebarStatus,
  renderSidebarChatStatusHtml,
} from '../app_front/features/sidebar/sidebarChatStatus.js';

test('isIconOnlySidebarStatus covers disconnected, connecting, active and needs-action', () => {
  assert.equal(isIconOnlySidebarStatus('disconnected'), true);
  assert.equal(isIconOnlySidebarStatus('connecting'), true);
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

test('applySidebarChatStatusEl does not rewrite markup when the tone is unchanged', () => {
  const el = {
    hidden: false,
    className: 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--connecting',
    innerHTML: '<span class="mdi mdi-loading mdi-spin" aria-hidden="true"></span>',
    attrs: { 'data-status-tone': 'connecting', title: 'old' },
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

test('renderSidebarChatStatusHtml keeps the attention label', () => {
  const actual = renderSidebarChatStatusHtml(
    { tone: 'attention', label: 'Completed' },
    (value) => `esc:${value}`
  );
  assert.equal(actual, 'esc:Completed');
});
