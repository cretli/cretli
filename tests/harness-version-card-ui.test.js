/**
 * Unit tests for Settings → Harness version card (pure model + DOM contract).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  buildHarnessVersionCardModel,
  buildOverviewVersionModel,
  countUpdatableHarnesses,
  dockerEnvironmentNote,
  packageUpdateHint,
  renderHarnessVersionCardHtml,
  verifyHarnessVersionCardDomContract,
} from '../app_front/features/settings/harnessVersionModel.js';

/** @param {string} key @param {object} [vars] */
function stubT(key, vars) {
  const leaf = key.replace(/^harnessVersion\./, '');
  const template = en.harnessVersion[leaf] || key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

const samplePayload = {
  checkedAt: '2026-10-08T10:00:00.000Z',
  updateCheckedAt: '2026-10-08T11:00:00.000Z',
  updateFromCache: true,
  updateEnvironment: { docker: true, termux: false, notes: ['Custom note'] },
  harnesses: [{
    harness: 'sdk',
    label: 'Cursor SDK',
    canUpdate: true,
    status: 'ok',
    packages: [{
      name: '@cursor/sdk',
      installed: '1.0.37',
      latest: '1.0.40',
      mode: 'manifest-bump',
      channel: 'stable',
      behind: true,
      canUpdate: true,
      updateError: '',
    }, {
      name: '@cursor/broken',
      installed: '1.0.0',
      latest: '—',
      mode: 'current',
      canUpdate: false,
      updateError: 'registry timeout',
    }],
  }, {
    harness: 'openrouter',
    label: 'OpenRouter',
    canUpdate: false,
    packages: [],
  }],
};

test('en and pl harnessVersion key sets match', () => {
  assert.deepEqual(Object.keys(en.harnessVersion).sort(), Object.keys(pl.harnessVersion).sort());
});

test('countUpdatableHarnesses and overview model', () => {
  assert.equal(countUpdatableHarnesses(samplePayload), 1);
  const overview = buildOverviewVersionModel(samplePayload, { lang: 'en' });
  assert.equal(overview.updatableCount, 1);
  assert.equal(overview.harnesses.length, 2);
});

test('package hints cover behind, manifest-bump and updateError', () => {
  assert.match(packageUpdateHint({ mode: 'manifest-bump', canUpdate: true }, stubT), /bump the dependency/i);
  assert.match(packageUpdateHint({ behind: true, latest: '2.0.0', canUpdate: true }, stubT), /2\.0\.0/);
  assert.match(packageUpdateHint({ updateError: 'registry timeout' }, stubT), /registry timeout/);
});

test('canUpdate alone does not imply newer version in hints or overview badge', () => {
  const capabilityOnly = {
    harnesses: [{
      harness: 'codex',
      label: 'Codex',
      canUpdate: true,
      status: 'ok',
      packages: [{
        name: '@openai/codex-sdk',
        installed: '1.0.0',
        latest: '—',
        mode: 'current',
        behind: false,
        canUpdate: true,
      }],
    }],
  };
  assert.equal(countUpdatableHarnesses(capabilityOnly), 0);
  const hint = packageUpdateHint(capabilityOnly.harnesses[0].packages[0], stubT);
  assert.equal(hint, '');
  const model = buildHarnessVersionCardModel(capabilityOnly, 'codex', { lang: 'en' });
  assert.equal(model.hasUpdates, false);
  const html = renderHarnessVersionCardHtml(model, { t: stubT, harnessLabel: 'Codex' });
  assert.doesNotMatch(html, /update\(s\) available/i);
  assert.doesNotMatch(html, /A newer version is available upstream/i);
  assert.match(html, /Installed packages match the latest checked versions/i);
  const overviewHtml = renderHarnessVersionCardHtml(
    buildOverviewVersionModel(capabilityOnly, { lang: 'en' }),
    { t: stubT },
  );
  assert.doesNotMatch(overviewHtml, /harness-version-badge/);
  assert.match(overviewHtml, /Up to date/);
});

test('behind or manifest-bump drives badge and newer-version hints', () => {
  const behindPayload = {
    harnesses: [{
      harness: 'sdk',
      label: 'SDK',
      canUpdate: true,
      status: 'ok',
      packages: [{
        name: '@cursor/sdk',
        installed: '1.0.0',
        latest: '2.0.0',
        mode: 'manifest-bump',
        behind: true,
        canUpdate: true,
      }],
    }],
  };
  assert.equal(countUpdatableHarnesses(behindPayload), 1);
  const overviewHtml = renderHarnessVersionCardHtml(
    buildOverviewVersionModel(behindPayload, { lang: 'en' }),
    { t: stubT },
  );
  assert.match(overviewHtml, /update\(s\) available/);
  assert.match(overviewHtml, /Updates available/);
  const singleHtml = renderHarnessVersionCardHtml(
    buildHarnessVersionCardModel(behindPayload, 'sdk', { lang: 'en' }),
    { t: stubT, harnessLabel: 'SDK' },
  );
  assert.match(singleHtml, /can be updated upstream/i);
  assert.match(singleHtml, /bump the dependency/i);
});

test('dockerEnvironmentNote includes docker flag and notes', () => {
  const note = dockerEnvironmentNote(samplePayload, samplePayload.updateEnvironment, stubT);
  assert.match(note, /Docker/i);
  assert.match(note, /Custom note/);
});

test('rendered card DOM contract: check + refresh, no install update', () => {
  const model = buildHarnessVersionCardModel(samplePayload, 'sdk', { lang: 'en' });
  const html = renderHarnessVersionCardHtml(model, { t: stubT, harnessLabel: 'Cursor SDK' });
  const contract = verifyHarnessVersionCardDomContract(html);
  assert.deepEqual(contract.errors, [], contract.errors.join('; '));
  assert.match(html, /manifest-bump/);
  assert.match(html, /registry timeout/);
  assert.match(html, /Check for updates/);
  assert.match(html, /Refresh models/);
  assert.doesNotMatch(html, /Update CLI/i);
  assert.doesNotMatch(html, /data-action="update"/i);
});

test('overview card shows badge when updates exist', () => {
  const overview = buildOverviewVersionModel(samplePayload, { lang: 'en' });
  const html = renderHarnessVersionCardHtml(overview, { t: stubT });
  assert.match(html, /update\(s\) available/);
  assert.match(html, /data-action="check-updates"/);
});

test('codex refresh hint appears for codex harness', () => {
  const model = buildHarnessVersionCardModel({ harnesses: [{ harness: 'codex', packages: [] }] }, 'codex');
  const html = renderHarnessVersionCardHtml(model, { t: stubT });
  assert.match(html, /network/i);
});
