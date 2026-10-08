/**
 * Scout shared proposal inbox UI contract (stage 5.3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCOUT_INBOX_ACTIONS,
  SCOUT_INBOX_PAGE_SIZE,
  SCOUT_INBOX_SOURCE_PAGE_SIZE,
  renderScoutFindingRow,
  renderScoutInboxHtml,
  scoutFindingSourceWindow,
  scoutSourceProfileLabel,
} from '../app_front/features/watcher/scoutFindingsInboxView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const settingsSource = readSource('app_front/features/settings/workspaceWatcherSettings.js');

/**
 * @param {number} n
 * @returns {object[]}
 */
function sources(n) {
  return Array.from({ length: n }, (_, index) => ({
    scoutId: `profile-${index + 1}`,
    scanId: `scan-${index + 1}`,
    chatId: `chat-${index + 1}`,
    harness: 'openrouter',
    model: 'm',
    scoutRevision: index + 1,
    at: `2026-02-0${(index % 9) + 1}T00:00:00.000Z`,
  }));
}

test('inbox renders loading, error, empty and capacity hint', () => {
  assert.match(renderScoutInboxHtml({ loading: true }), /data-scout-inbox-loading/);
  assert.match(renderScoutInboxHtml({ error: 'boom' }), /data-scout-inbox-error/);
  assert.match(renderScoutInboxHtml({ findings: [] }), /data-scout-inbox-empty/);
  assert.match(renderScoutInboxHtml({ findings: [], capacityExceeded: true }), /data-scout-inbox-overflow="true"/);
});

test('sources window is bounded and expands without dropping attribution', () => {
  const list = sources(5);
  const first = scoutFindingSourceWindow(list, SCOUT_INBOX_SOURCE_PAGE_SIZE);
  assert.equal(first.visible.length, SCOUT_INBOX_SOURCE_PAGE_SIZE);
  assert.equal(first.hidden, 2);
  const expanded = scoutFindingSourceWindow(list, SCOUT_INBOX_SOURCE_PAGE_SIZE + 2);
  assert.equal(expanded.visible.length, 5);
  assert.equal(expanded.hidden, 0);
});

test('many-source finding renders every visible source with a profile label and todo id', () => {
  const profiles = [
    { id: 'profile-1', name: 'Alpha' },
    { id: 'profile-2', name: 'Beta' },
    { id: 'profile-3', name: 'Gamma' },
  ];
  const finding = {
    id: 'f1',
    status: 'pending',
    title: 'Slow query',
    category: 'bug',
    createdAt: '2026-02-01T00:00:00.000Z',
    sources: sources(3),
    todoId: 'todo-abc-12345678',
  };
  const html = renderScoutFindingRow(finding, {
    profiles,
    sourceLimit: 10,
    getTodoTitle: () => 'Fix slow query',
  });
  assert.match(html, /Alpha \(profile/);
  assert.match(html, /Beta \(profile/);
  assert.match(html, /Gamma \(profile/);
  assert.match(html, /data-scout-finding-id="f1"/);
  assert.match(html, /todo-abc-12345678/);
  assert.match(html, /data-scout-inbox-action="open-todo"/);
  assert.match(html, /data-scout-inbox-action="inbox-accept"/);
  assert.match(html, /data-scout-inbox-action="inbox-reject"/);
  assert.equal(scoutSourceProfileLabel({ scoutId: 'profile-9' }, profiles), 'profile-9');
});

test('no rendered inbox action is a dead action', () => {
  const html = renderScoutInboxHtml({
    findings: [{
      id: 'f1',
      status: 'pending',
      title: 'x',
      category: 'bug',
      createdAt: '2026-01-01',
      sources: sources(4),
      todoId: 'todo-1',
    }],
    total: 40,
    max: 25,
    profiles: [{ id: 'profile-1', name: 'Alpha' }],
  });
  const rendered = new Set([...html.matchAll(/data-scout-inbox-action="([^"]+)"/g)].map((m) => m[1]));
  for (const action of rendered) {
    assert.ok(SCOUT_INBOX_ACTIONS.includes(action), `${action} must be in SCOUT_INBOX_ACTIONS`);
    assert.ok(settingsSource.includes(`'${action}'`), `settings must reference ${action}`);
  }
  assert.match(settingsSource, /SCOUT_INBOX_ACTIONS\.includes\(inboxAction\)/);
  assert.match(settingsSource, /cretli-open-todo/);
  assert.match(settingsSource, /action: action === 'inbox-accept' \? 'accept' : 'reject'/);
  assert.match(settingsSource, /data-scout-inbox-filter/);
  assert.doesNotMatch(settingsSource, /approve-plan|approvePlan/i);
});

test('inbox load-more label matches the step the panel applies', () => {
  const shown = 25;
  const hidden = 15;
  const html = renderScoutInboxHtml({
    findings: Array.from({ length: shown }, (_, i) => ({
      id: `f${i}`,
      status: 'accepted',
      title: 'x',
      category: 'bug',
      createdAt: '2026-01-01',
      sources: sources(1),
    })),
    total: shown + hidden,
    max: shown,
    profiles: [{ id: 'profile-1', name: 'Alpha' }],
  });
  const expectedStep = Math.min(hidden, SCOUT_INBOX_PAGE_SIZE);
  const expectedLabel = en.settings.watcherScoutInboxMore.replace('{n}', String(expectedStep));
  assert.match(html, new RegExp(expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('pending row with autoCreate on does not claim the scan was already captured', () => {
  const html = renderScoutFindingRow({
    id: 'f-pending',
    status: 'pending',
    title: 'Issue',
    category: 'bug',
    createdAt: '2026-02-01T00:00:00.000Z',
    sources: sources(1),
  }, { autoCreate: true, profiles: [{ id: 'profile-1', name: 'Alpha' }] });
  assert.doesNotMatch(html, /data-scout-finding-autocreate="on"/);
  assert.doesNotMatch(html, new RegExp(en.settings.watcherScoutInboxAutoCreateManualHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('PL and EN define every Scout inbox key', () => {
  const keys = [
    'watcherScoutInboxTitle',
    'watcherScoutInboxHint',
    'watcherScoutInboxLoading',
    'watcherScoutInboxEmpty',
    'watcherScoutInboxError',
    'watcherScoutInboxCount',
    'watcherScoutInboxMore',
    'watcherScoutInboxCapacityHint',
    'watcherScoutInboxAllProfiles',
    'watcherScoutInboxAllCategories',
    'watcherScoutInboxAllStatuses',
    'watcherScoutInboxFilter_scoutId',
    'watcherScoutInboxFilter_category',
    'watcherScoutInboxFilter_status',
    'watcherScoutInboxActionsLabel',
    'watcherScoutInboxReload',
    'watcherScoutInboxNoProfile',
    'watcherScoutInboxSources',
    'watcherScoutInboxSourcesMore',
    'watcherScoutInboxSourcesNone',
    'watcherScoutInboxTodo',
    'watcherScoutInboxOpenTodo',
    'watcherScoutInboxAccept',
    'watcherScoutInboxReject',
    'watcherScoutInboxAccepted',
    'watcherScoutInboxRejected',
    'watcherScoutInboxProposed',
    'watcherScoutInboxFiles',
    'watcherScoutInboxFilesMore',
    'watcherScoutInboxAutoCreateOn',
    'watcherScoutInboxAutoCreateOff',
    'watcherScoutInboxAutoCreatePending',
    'watcherScoutInboxAutoCreateManualHint',
    'watcherScoutFindingStatus_unknown',
    'watcherScoutFindingStatus_pending',
    'watcherScoutFindingStatus_accepted',
    'watcherScoutFindingStatus_rejected',
  ];
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of keys) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});
