import assert from 'node:assert/strict';
import {
  LOGS_FILTER_FREEZE,
  isUiFreezeReportTag,
  isUiFreezeDiagnosticsEnabled,
  matchesLogsPanelFilter,
  shouldLogUiFreezeLongTask,
} from '../app_front/lib/uiFreezeTrace.js';

assert.equal(isUiFreezeDiagnosticsEnabled(), false);
assert.equal(isUiFreezeReportTag('ui-freeze-ws'), true);
assert.equal(isUiFreezeReportTag('fork-title'), false);
assert.equal(matchesLogsPanelFilter('ui-freeze', LOGS_FILTER_FREEZE), true);
assert.equal(matchesLogsPanelFilter('fork-title', LOGS_FILTER_FREEZE), false);
assert.equal(shouldLogUiFreezeLongTask(100), false);

console.log('ui-freeze-trace.test.js: ok');
