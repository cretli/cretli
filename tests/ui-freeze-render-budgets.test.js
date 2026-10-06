/**
 * Stage 0.2 — exported UI freeze budgets stay aligned with config and fixtures.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_HISTORY_INITIAL_TAIL, CHAT_HISTORY_OLDER_PAGE } from '../app_front/config.js';
import {
  HISTORY_REPLAY_CHUNK_SIZE,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import {
  LONG_TASK_IDLE_MS,
  LONG_TASK_RESUME_MS,
} from '../app_front/lib/chatPerfBudget.js';
import { DEFAULT_SLICE_BUDGET_MS } from '../app_front/lib/schedulerYield.js';
import { SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS } from '../app_front/features/sidebar/sidebarArchiveVirtualizer.js';
import {
  UI_FREEZE_CHAT_DOM_NODES_SOFT_CAP,
  UI_FREEZE_CHAT_HISTORY_INITIAL_TAIL,
  UI_FREEZE_CHAT_HISTORY_OLDER_PAGE,
  UI_FREEZE_CHAT_MOUNTED_RECORD_CAP,
  UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES,
  UI_FREEZE_INPUT_LATENCY_MS,
  UI_FREEZE_REPAIR_PATH_TASK_MS,
  UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS,
  UI_FREEZE_SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS,
  UI_FREEZE_SLICE_BUDGET_MS,
  UI_FREEZE_SYNTHETIC_FIXTURE_MAX_RECORD_UTF8_BYTES,
  UI_FREEZE_SYNTHETIC_FIXTURE_RECORD_COUNT,
  UI_FREEZE_SYNTHETIC_FIXTURE_TOTAL_JSON_BYTES,
  UI_FREEZE_TRACE_REGRESSION_DOM_NODES,
  UI_FREEZE_TRACE_REGRESSION_LAYOUT_OBJECTS,
} from '../app_front/lib/uiFreezeRenderBudgets.js';

assert.equal(UI_FREEZE_SLICE_BUDGET_MS, DEFAULT_SLICE_BUDGET_MS);
assert.equal(UI_FREEZE_SLICE_BUDGET_MS, 8);
assert.equal(UI_FREEZE_REPAIR_PATH_TASK_MS, LONG_TASK_RESUME_MS);
assert.equal(UI_FREEZE_REPAIR_PATH_TASK_MS, 50);
assert.equal(UI_FREEZE_INPUT_LATENCY_MS, LONG_TASK_IDLE_MS);
assert.equal(UI_FREEZE_INPUT_LATENCY_MS, 200);
assert.equal(UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS, UI_FREEZE_SLICE_BUDGET_MS);
assert.equal(HISTORY_REPLAY_SYNC_HEAD, 20);
assert.equal(HISTORY_REPLAY_CHUNK_SIZE, 8);

assert.equal(UI_FREEZE_CHAT_HISTORY_INITIAL_TAIL, CHAT_HISTORY_INITIAL_TAIL);
assert.equal(UI_FREEZE_CHAT_HISTORY_OLDER_PAGE, CHAT_HISTORY_OLDER_PAGE);
assert.equal(UI_FREEZE_CHAT_MOUNTED_RECORD_CAP, CHAT_HISTORY_INITIAL_TAIL);
assert.equal(UI_FREEZE_SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS, SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS);

assert.ok(UI_FREEZE_CHAT_DOM_NODES_SOFT_CAP < UI_FREEZE_TRACE_REGRESSION_DOM_NODES);
assert.ok(UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES < UI_FREEZE_SYNTHETIC_FIXTURE_MAX_RECORD_UTF8_BYTES);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(
    path.join(projectRoot, 'tests/fixtures/synthetic-history-replay-records.json'),
    'utf8',
  ),
);
assert.equal(fixture.records.length, UI_FREEZE_SYNTHETIC_FIXTURE_RECORD_COUNT);

let maxRecordBytes = 0;
let totalJsonBytes = 0;
for (const record of fixture.records) {
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  totalJsonBytes += bytes;
  if (bytes > maxRecordBytes) maxRecordBytes = bytes;
}
assert.equal(maxRecordBytes, UI_FREEZE_SYNTHETIC_FIXTURE_MAX_RECORD_UTF8_BYTES);
assert.equal(totalJsonBytes, UI_FREEZE_SYNTHETIC_FIXTURE_TOTAL_JSON_BYTES);

assert.equal(UI_FREEZE_TRACE_REGRESSION_DOM_NODES, 509_961);
assert.equal(UI_FREEZE_TRACE_REGRESSION_LAYOUT_OBJECTS, 276_323);

console.log('ui-freeze-render-budgets.test.js OK');
