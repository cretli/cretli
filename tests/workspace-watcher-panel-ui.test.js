/**
 * Workspace Watcher panel UI contract.
 *
 * The pure view helpers are imported directly (no DOM needed). The wiring is
 * asserted from source, mirroring `workspace-watcher-settings-ui.test.js`, so a
 * refactor that drops the top bar or the "Why?" log fails loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveWatcherStatus,
  renderWatcherBarHtml,
  renderWatcherDecisionsHtml,
} from '../app_front/features/watcher/watcherStatus.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('status maps off / paused / stopped / working / waiting / idle', () => {
  assert.equal(deriveWatcherStatus({ watcher: { mode: 'off' } }).key, 'off');
  assert.equal(deriveWatcherStatus({ watcher: { mode: 'autopilot', paused: true } }).key, 'paused');
  assert.equal(
    deriveWatcherStatus({ watcher: { mode: 'autopilot', stopReason: 'loop_same_findings' } }).key,
    'blocked',
  );
  const working = deriveWatcherStatus(
    { watcher: { mode: 'autopilot', activeCycle: { todoIds: ['todo-12345678'] } } },
    () => 'Fix the thing',
  );
  assert.equal(working.key, 'working');
  assert.equal(working.todoId, 'todo-12345678');
  assert.match(working.label, /Fix the thing/);
  assert.equal(
    deriveWatcherStatus({ watcher: { mode: 'observe' }, snapshot: { readyTodoCount: 2 } }).key,
    'waiting',
  );
  assert.equal(
    deriveWatcherStatus({ watcher: { mode: 'observe' }, snapshot: { readyTodoCount: 0 } }).key,
    'idle',
  );
});

test('waiting guardrails are shown as a reason, not as broken', () => {
  const status = deriveWatcherStatus({
    watcher: { mode: 'autopilot' },
    guardrails: { kind: 'wait_quiet_hours', reason: 'quiet hours' },
    snapshot: { readyTodoCount: 1 },
  });
  assert.equal(status.key, 'waiting');
  assert.match(status.label, /quiet hours/);
  assert.doesNotMatch(status.label, /Blocked|Zablokowany/i);
});

test('stopReason stays blocked while guardrail waits use the waiting label', () => {
  const blocked = deriveWatcherStatus({
    watcher: { mode: 'autopilot', stopReason: 'operator stop' },
  });
  assert.equal(blocked.key, 'blocked');
  assert.match(blocked.label, /operator stop/);
});

test('the top bar exposes mode, pause, why and the orchestrator link', () => {
  const html = renderWatcherBarHtml({
    watcher: {
      mode: 'autopilot',
      orchestratorChatId: 'orch-chat-1234',
      activeCycle: { todoIds: ['t1'] },
    },
    snapshot: { readyTodoCount: 1 },
  }, { getTodoTitle: () => 'Ship it', whyOpen: true });
  assert.match(html, /data-watcher-mode/);
  assert.match(html, /value="off"/);
  assert.match(html, /value="observe"/);
  assert.match(html, /value="autopilot" selected/);
  assert.match(html, /data-watcher-action="pause"/);
  assert.match(html, /data-watcher-why aria-expanded="true"/);
  assert.match(html, /data-watcher-open-chat="orch-chat-1234"/);
  assert.match(html, /data-state="working"/);
  assert.match(html, /Ship it/);
});

test('multiple active cycles show a count/list instead of only slot 0', () => {
  const view = {
    watcher: {
      mode: 'autopilot',
      activeCycles: [
        { todoIds: ['t1'], chatId: 'c1' },
        { todoIds: ['t2'], chatId: 'c2' },
      ],
    },
    snapshot: { readyTodoCount: 2 },
  };
  const status = deriveWatcherStatus(view, (id) => (id === 't1' ? 'First' : 'Second'));
  assert.equal(status.key, 'working');
  assert.equal(status.cycleCount, 2);
  assert.match(status.label, /2/);
  assert.match(status.reason, /First/);
  assert.match(status.reason, /Second/);
  const html = renderWatcherBarHtml(view, { getTodoTitle: (id) => (id === 't1' ? 'First' : 'Second') });
  assert.match(html, /data-watcher-cycle-count="2"/);
  assert.match(html, /data-watcher-open-chat="c1"/);
  assert.match(html, /data-watcher-open-chat="c2"/);
  assert.match(html, /Working on 2 cycles/);
});

test('the Why? log renders timestamp, decision and reason', () => {
  const html = renderWatcherDecisionsHtml([
    { at: '2026-10-03T10:00:00.000Z', kind: 'start_cycle', reason: 'idle_with_ready_work' },
  ]);
  assert.match(html, /2026-10-03T10:00:00.000Z/);
  assert.match(html, /start_cycle/);
  assert.match(html, /idle_with_ready_work/);
  assert.match(renderWatcherDecisionsHtml([]), /todo-watcher-why-empty/);
});

test('the Why? log names blocking chats from unknownChats on the decision', () => {
  const html = renderWatcherDecisionsHtml([
    {
      at: '2026-10-03T10:00:00.000Z',
      kind: 'wait_active',
      reason: 'unknown_liveness',
      unknownChats: [{ chatId: 'claim-chat', reason: 'state_missing' }],
    },
  ]);
  assert.match(html, /unknown_liveness/);
  assert.match(html, /claim-chat/);
  assert.match(html, /state_missing/);
});

test('the Why? log names the chat holding a full cycle slot', () => {
  const html = renderWatcherDecisionsHtml([
    {
      at: '2026-10-05T10:00:00.000Z',
      kind: 'wait_active',
      reason: 'cycle_active',
      slotChats: [{ chatId: 'holder-chat-id', cycleId: 'holding' }],
    },
  ]);
  assert.match(html, /cycle_active/);
  assert.match(html, /holder-chat-id/);
});

test('the Why? log names chats and delegation tokens holding maxParallel', () => {
  const html = renderWatcherDecisionsHtml([
    {
      at: '2026-10-05T11:46:00.000Z',
      kind: 'wait_active',
      reason: 'max_parallel',
      slotHolders: ['human-busy-chat', 'delegation:abcdef12-3456'],
    },
  ]);
  assert.match(html, /max_parallel/);
  assert.match(html, /human-busy-chat/);
  assert.match(html, /delegation:abcdef12-3456/);
});

test('todo rows show claimed-by and queued badges', () => {
  const todoPanel = readSource('app_front/todoPanel.js');
  assert.match(todoPanel, /todo\.claimedBy/);
  assert.match(todoPanel, /todo\.queued/);
  assert.match(todoPanel, /claimedByChatId/);
  assert.match(todoPanel, /isWatcherAutopilot\(\)/);
});

test('todo badges repaint when the watcher view updates', () => {
  const todoPanel = readSource('app_front/todoPanel.js');
  const watcherPanel = readSource('app_front/features/watcher/watcherPanel.js');
  assert.match(todoPanel, /export function repaintTodoRowBadges/);
  assert.match(todoPanel, /cretli:workspace-watcher-view-updated/);
  assert.match(watcherPanel, /cretli:workspace-watcher-view-updated/);
});

test('panel and i18n are wired', () => {
  const panel = readSource('app_front/features/watcher/watcherPanel.js');
  const todoPanel = readSource('app_front/todoPanel.js');
  const html = readSource('public/index.html');
  assert.match(panel, /\/api\/workspace-watcher/);
  assert.match(panel, /initWatcherPanel/);
  assert.match(panel, /refreshWatcherPanel/);
  assert.match(panel, /data-watcher-mode/);
  assert.match(todoPanel, /features\/watcher\/watcherPanel\.js/);
  assert.match(todoPanel, /initWatcherPanel\(/);
  assert.match(todoPanel, /refreshWatcherPanel\(\)/);
  assert.match(html, /id="todo-watcher-bar"/);
  assert.match(html, /id="todo-watcher-why"/);
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of [
      'watcherBarTitle',
      'watcherMode',
      'watcherStatusWaiting',
      'watcherStatusWaitingReason',
      'watcherStatusWorking',
      'watcherStatusWorkingMany',
      'watcherStatusIdle',
      'watcherStatusBlocked',
      'watcherStatusPaused',
      'watcherStatusOff',
      'watcherPause',
      'watcherResume',
      'watcherWhy',
      'watcherWhyEmpty',
      'watcherDecisionAt',
      'watcherDecisionKind',
      'watcherDecisionReason',
      'watcherOpenOrchestrator',
    ]) {
      assert.ok(dict.todo?.[key], `${lang}.todo.${key} is missing`);
    }
  }
});
