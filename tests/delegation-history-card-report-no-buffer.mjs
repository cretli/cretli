/**
 * Child process: import report helpers with global Buffer disabled.
 */
import assert from 'node:assert/strict';
import {
  buildHistoryCardReportHostHtml,
  buildHistoryCardReportViewModel,
  measureUtf8ByteLength,
  truncateUtf8Text,
} from '../app_front/lib/delegationHistoryCardReport.js';

assert.equal(typeof globalThis.Buffer, 'undefined');

const line = `${'word '.repeat(80)}\n\n`;
let body = '';
while (measureUtf8ByteLength(body) < 800 * 1024) {
  body += line;
}
const model = buildHistoryCardReportViewModel({ fullText: body });
assert.equal(model.isTruncated, true);

const slice = truncateUtf8Text('ąę'.repeat(500), 64);
assert.ok(slice.utf8Bytes <= 64);
assert.ok(slice.text.length > 0);

const html = buildHistoryCardReportHostHtml(body, {
  escapeHtml: (v) => String(v),
  t: (key) => key,
  renderMarkdown: (source) => `<pre>${source.length}</pre>`,
});
assert.match(html, /data-report-content-key="/);
assert.match(html, /data-report-action="expand"/);

process.stdout.write('delegation-history-card-report-no-buffer.mjs OK\n');
