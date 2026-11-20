import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildHealthCardModel, renderHealthCardHtml } from '../app_front/features/harness-health/harnessHealthModel.js';
import {
  buildUnclassifiedSectionsModel,
  redactForRender,
  renderUnclassifiedSectionsHtml,
} from '../app_front/features/harness-health/harnessUnclassifiedModel.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? JSON.stringify(vars) : ''}`;
const ID = '0123456789abcdef';

const entry = {
  harness: 'sdk',
  runs: 3,
  okRuns: 2,
  errorRuns: 1,
  unclassifiedErrors: {
    items: [{ id: ID, model: 'm1', message: 'bad <b>x</b> key=sk-abcdef0123456789ABCDEF at /home/me/p/.env https://api.example.com/v1', count: 4, version: 4, lastSeenAt: '2026-10-07T10:11:12Z' }],
    compat: [{ id: 'fedcba9876543210', model: 'm1', message: 'Tool read not found in agent cli', count: 2, version: 2, lastSeenAt: '2026-10-07T10:11:12Z' }],
  },
  telemetryCoverage: {
    categories: [
      { category: 'ok', total: 16, timingUnknownShare: 0.25, measurementUnknownShare: 0.5, alarm: true, severity: 'high' },
      { category: 'aborted', total: 5, timingUnknownShare: 1, measurementUnknownShare: 1, alarm: false, severity: 'none' },
    ],
  },
};

test('sections render with an ACK action, separate compat block and coverage alarm', () => {
  const html = renderHealthCardHtml(buildHealthCardModel(entry, { lang: 'en' }), { t, lang: 'en' });
  assert.match(html, /data-role="unclassified"/);
  assert.match(html, /data-role="tool-compat"/);
  assert.match(html, /data-action="ack-unclassified" data-id="0123456789abcdef" data-version="4"/);
  assert.match(html, /harnessHealth\.coverageAlarm/);
  // The compat entry sits in its own block, not in the unrecognized list.
  const [unclassified, rest] = html.split('data-role="tool-compat"');
  assert.ok(!unclassified.includes('Tool read not found'));
  assert.ok(rest.includes('Tool read not found'));
  // Only the successful category alarms.
  assert.equal((html.match(/harness-health-coverage-alarm/g) || []).length, 1);
});

test('render never shows secrets, home paths or URLs and escapes markup', () => {
  const html = renderHealthCardHtml(buildHealthCardModel(entry, { lang: 'en' }), { t, lang: 'en' });
  for (const leak of ['sk-abcdef', '/home/me', 'api.example.com', 'https://', '<b>x</b>']) {
    assert.ok(!html.includes(leak), `leaked ${leak}`);
  }
  assert.equal(redactForRender('token=abc at ~/x and http://a.b/c'), '<secret> at <path> and <url>');
});

test('nothing to show renders nothing; invalid ids get no ACK button', () => {
  assert.equal(renderUnclassifiedSectionsHtml(buildUnclassifiedSectionsModel(null, null), { t }), '');
  const model = buildUnclassifiedSectionsModel({ items: [{ id: '../x', message: 'm', count: 1 }] }, null);
  assert.ok(!renderUnclassifiedSectionsHtml(model, { t }).includes('ack-unclassified'));
});

test('i18n keys exist in pl and en; new SCSS uses tokens only', () => {
  const html = renderUnclassifiedSectionsHtml(buildUnclassifiedSectionsModel(entry.unclassifiedErrors, entry.telemetryCoverage), { t });
  const keys = new Set([...html.matchAll(/harnessHealth\.([A-Za-z_]+)/g)].map((m) => m[1]));
  keys.add('unclassifiedAcked');
  keys.add('unclassifiedAckStale');
  keys.add('unclassifiedAckFailed');
  for (const category of ['ok', 'error', 'limit', 'aborted']) keys.add(`coverageCategory_${category}`);
  assert.ok(keys.size > 15);
  for (const key of keys) {
    assert.ok(en.harnessHealth[key], `en missing ${key}`);
    assert.ok(pl.harnessHealth[key], `pl missing ${key}`);
  }
  const scss = readFileSync(new URL('../app_front/css/features/settings/_harness.scss', import.meta.url), 'utf8');
  const added = scss.slice(scss.indexOf('// Unrecognized provider errors'));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(added), 'no hardcoded hex');
});
