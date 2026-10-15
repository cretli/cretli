/**
 * Approval audit summary: counters only, tolerant of corrupt/empty files.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  readApprovalAuditSummary,
  normalizeApprovalAuditSummaryDays,
} from '../lib/approval/approval-audit.js';
import { buildApprovalAuditStatsLines } from '../app_front/features/approval/approvalBrokerSettings.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const iso = (offsetDays) => new Date(NOW - offsetDays * 86_400_000).toISOString();

async function withFile(content, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'audit-summary-'));
  const file = path.join(dir, 'a.jsonl');
  if (content !== null) fs.writeFileSync(file, content);
  try {
    return await fn(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('counts decisions by source and skips by gate reason, no leaks', async () => {
  const rows = [
    { ts: iso(1), source: 'local', finalDecision: 'allow_once', command: 'cat /etc/secret-path', requestId: 'req-LEAK' },
    { ts: iso(1), kind: 'human_permission_decision', source: 'user', requestId: 'req-LEAK2' },
    { ts: iso(1), kind: 'human_permission_decision', requestId: 'r' },
    { ts: iso(1), kind: 'advisor_assessment', source: 'advisor', advisorAutomationOutcome: 'allow_once' },
    { ts: iso(1), kind: 'advisor_assessment', advisorAutomationOutcome: 'ask_user' },
    { ts: iso(1), kind: 'advisor_skip', reason: 'not_low_risk' },
    { ts: iso(2), kind: 'advisor_skip', reason: 'not_low_risk' },
    { ts: iso(2), kind: 'advisor_skip', reason: 'rm -rf /home/x token=abc' },
    { ts: iso(30), kind: 'advisor_skip', reason: 'too_old' },
  ];
  const text = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{broken json\n`;
  await withFile(text, async (file) => {
    const out = await readApprovalAuditSummary({ file, days: 7, now: NOW });
    assert.deepEqual(out.decisions, { advisor: 1, local: 1, user: 1, unknown: 1, total: 4 });
    assert.equal(out.skips.total, 3);
    assert.deepEqual(out.skips.reasons, [
      { reason: 'not_low_risk', count: 2 },
      { reason: 'other', count: 1 },
    ]);
    const dump = JSON.stringify(out);
    for (const leak of ['secret-path', 'req-LEAK', 'rm -rf', 'token=abc', '/etc']) {
      assert.equal(dump.includes(leak), false, `leaked ${leak}`);
    }
  });
});

test('empty and missing file give zero counters; maxLines keeps the tail', async () => {
  await withFile('', async (file) => {
    const out = await readApprovalAuditSummary({ file, now: NOW });
    assert.equal(out.decisions.total, 0);
    assert.equal(out.skips.total, 0);
  });
  await withFile(null, async (file) => {
    const out = await readApprovalAuditSummary({ file, now: NOW });
    assert.equal(out.linesScanned, 0);
  });
  const lines = Array.from({ length: 10 }, () => JSON.stringify({ ts: iso(0), source: 'user', kind: 'human_permission_decision' }));
  await withFile(`${lines.join('\n')}\n`, async (file) => {
    const out = await readApprovalAuditSummary({ file, now: NOW, maxLines: 4 });
    assert.equal(out.decisions.user, 4);
  });
  assert.equal(normalizeApprovalAuditSummaryDays('999'), 90);
  assert.equal(normalizeApprovalAuditSummaryDays('x'), 7);
});

test('stats lines render and i18n keys exist in both locales', () => {
  const lines = buildApprovalAuditStatsLines({
    decisions: { advisor: 1, local: 2, user: 3, unknown: 4 },
    skips: { total: 2, reasons: [{ reason: 'not_low_risk', count: 2 }] },
  });
  assert.equal(lines.length, 2);
  for (const locale of ['en', 'pl']) {
    const dict = fs.readFileSync(path.join(process.cwd(), `app_front/i18n/${locale}.js`), 'utf8');
    for (const key of ['approvalAuditStatsTitle', 'approvalAuditStatsDecisions', 'approvalAuditStatsSkips', 'approvalAuditStatsNoSkips', 'approvalAdvisorOpenCodeCardsHint']) {
      assert.match(dict, new RegExp(`${key}:`));
    }
  }
  const html = fs.readFileSync(path.join(process.cwd(), 'public/index.html'), 'utf8');
  assert.match(html, /data-i18n="settings\.approvalAdvisorOpenCodeCardsHint"/);
  assert.match(html, /id="approval-audit-stats"/);
});
