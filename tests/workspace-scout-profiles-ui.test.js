/**
 * Scout profile list UI contract (stage 5.1).
 *
 * The pure view helpers are imported directly (no DOM). The settings wiring is
 * asserted from source, the same way `workspace-watcher-settings-ui.test.js`
 * does: every rendered action must be dispatched by the panel, the CAS conflict
 * must surface a readable message, and each mutation must re-read the list.
 *
 * PL/EN key parity is asserted for every new string so a half-translated list
 * fails loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCOUT_PROFILE_ACTIONS,
  nextScoutProfileName,
  renderScoutProfileRow,
  renderScoutProfilesHtml,
  scoutActionDisabled,
  scoutLimitText,
  scoutNextRunText,
  scoutProfileState,
  scoutReasonText,
  scoutStateKey,
  scoutStateLabel,
} from '../app_front/features/watcher/scoutProfilesView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const settingsSource = readSource('app_front/features/settings/workspaceWatcherSettings.js');

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function profile(overrides = {}) {
  return {
    id: 'p1',
    revision: 3,
    name: 'Wydajność',
    objective: 'Znajdź N+1 i brakujące indeksy.',
    enabled: true,
    archivedAt: '',
    schedule: { mode: 'interval', intervalHours: 6 },
    limits: { maxPerDay: 4 },
    state: {
      lastRunAt: '2026-02-01T00:00:00.000Z',
      nextRunAt: '2026-02-02T12:00:00.000Z',
      usedToday: 1,
      maxPerDay: 4,
      remainingToday: 3,
      pendingFindings: 2,
      running: 1,
      blockedReason: '',
      archived: false,
    },
    ...overrides,
  };
}

const NOW = Date.parse('2026-02-01T12:00:00.000Z');

test('the list renders loading, error and empty states', () => {
  assert.match(renderScoutProfilesHtml({ loading: true }), /data-scout-profiles-loading/);
  assert.match(renderScoutProfilesHtml({ error: 'boom' }), /data-scout-profiles-error/);
  assert.match(renderScoutProfilesHtml({ error: 'boom' }), /boom/);
  assert.match(renderScoutProfilesHtml({ profiles: [] }), /data-scout-profiles-empty/);
  // The header (create/reload) is present in every state so the operator can act.
  for (const html of [
    renderScoutProfilesHtml({ loading: true }),
    renderScoutProfilesHtml({ error: 'boom' }),
    renderScoutProfilesHtml({ profiles: [] }),
  ]) {
    assert.match(html, /data-scout-action="create"/);
    assert.match(html, /data-scout-action="reload"/);
  }
});

test('the state badge is archived > disabled > enabled', () => {
  assert.equal(scoutStateKey(profile()), 'enabled');
  assert.equal(scoutStateKey(profile({ enabled: false })), 'disabled');
  assert.equal(scoutStateKey(profile({ archivedAt: '2026-01-01T00:00:00.000Z' })), 'archived');
  assert.equal(
    scoutStateKey(profile({ enabled: true, state: { ...profile().state, archived: true } })),
    'archived',
    'the additive state.archived flag alone is enough',
  );
  assert.equal(scoutStateLabel(profile()), 'Enabled');
  assert.equal(scoutStateLabel(profile({ enabled: false })), 'Disabled');
  assert.equal(scoutStateLabel(profile({ archivedAt: 'x' })), 'Archived');

  assert.match(renderScoutProfileRow(profile(), { now: NOW }), /data-scout-state="enabled"/);
  assert.match(renderScoutProfileRow(profile({ enabled: false }), { now: NOW }), /data-scout-state="disabled"/);
  assert.match(
    renderScoutProfileRow(profile({ archivedAt: '2026-01-01T00:00:00.000Z' }), { now: NOW }),
    /data-scout-state="archived"/,
  );
});

test('the meta line shows last/next run, daily limit and pending/running counts', () => {
  const html = renderScoutProfilesHtml({ profiles: [profile()], now: NOW });
  assert.match(html, /data-scout-id="p1"/);
  assert.match(html, /2026-02-01T00:00:00.000Z/);
  assert.match(html, /1 \/ 4 · 3 left/);
  assert.match(html, /Pending proposals: 2/);
  assert.match(html, /Running now: 1/);
  // An interval + enabled profile gets the live countdown hook.
  assert.match(html, /data-watcher-countdown="/);

  const blocked = profile({ state: { ...profile().state, blockedReason: 'scout_disabled' } });
  assert.match(
    renderScoutProfilesHtml({ profiles: [blocked], now: NOW }),
    /Scout is disabled\./,
    'the manual-run blocker is translated per row, not shown as a raw code',
  );
  assert.equal(
    scoutReasonText('profile_scan_active'),
    'A scan of this profile is already running or awaiting reconciliation.',
  );
});

test('an occupied scan explains profile_scan_active in the row instead of a raw code', () => {
  const busy = profile({ state: { ...profile().state, running: 1, blockedReason: 'profile_scan_active' } });
  const html = renderScoutProfilesHtml({ profiles: [busy], now: NOW });
  assert.match(html, /A scan of this profile is already running or awaiting reconciliation\./);
  assert.doesNotMatch(html, /profile_scan_active/);
});

test('scoutLimitText falls back to max-used and tolerates a missing state', () => {
  assert.equal(scoutLimitText(profile()), '1 / 4 · 3 left');
  assert.equal(scoutLimitText({ limits: { maxPerDay: 5 } }), '0 / 0 · 0 left');
  assert.equal(scoutProfileState(null).maxPerDay, 0);
});

test('next-run text distinguishes manual, archived, due and countdown', () => {
  assert.equal(scoutNextRunText(profile({ schedule: { mode: 'manual' } }), NOW), 'manual only');
  assert.equal(scoutNextRunText(profile({ enabled: false }), NOW), 'manual only');
  assert.equal(scoutNextRunText(profile({ archivedAt: '2026-01-01T00:00:00.000Z' }), NOW), 'archived');
  const due = profile({ state: { ...profile().state, nextRunAt: '2026-02-01T11:00:00.000Z' } });
  assert.equal(scoutNextRunText(due, NOW), 'due now');
  assert.equal(scoutNextRunText(profile(), NOW), '1d 0h');
});

test('actions disable for archived and busy rows, but keep a manual run for a disabled profile', () => {
  const disabled = profile({ enabled: false });
  assert.equal(scoutActionDisabled(disabled, 'run'), false, 'a disabled profile can still be run manually');
  assert.equal(scoutActionDisabled(disabled, 'toggle'), false);
  assert.equal(scoutActionDisabled(disabled, 'archive'), false);
  assert.equal(scoutActionDisabled(disabled, 'duplicate'), false);

  const archived = profile({ archivedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(scoutActionDisabled(archived, 'run'), true);
  assert.equal(scoutActionDisabled(archived, 'toggle'), true);
  assert.equal(scoutActionDisabled(archived, 'archive'), true);
  assert.equal(scoutActionDisabled(archived, 'duplicate'), false);
  assert.equal(scoutActionDisabled(archived, 'reload'), false);

  assert.equal(scoutActionDisabled(profile(), 'create', { busy: true }), true);
  assert.equal(scoutActionDisabled(profile(), 'reload', { busy: true }), true);
  assert.equal(scoutActionDisabled(profile(), 'toggle', { busy: true }), true);
});

test('an archived row renders run/archive/toggle disabled and a busy row is aria-busy', () => {
  const archived = profile({ id: 'p2', archivedAt: '2026-01-01T00:00:00.000Z' });
  const html = renderScoutProfilesHtml({ profiles: [profile(), archived], now: NOW });
  assert.match(html, /data-scout-action="run" data-scout-id="p2"[^>]*disabled/);
  assert.match(html, /data-scout-action="archive" data-scout-id="p2"[^>]*disabled/);
  assert.match(html, /data-scout-action="toggle" data-scout-id="p2"[^>]*disabled/);
  assert.match(html, /data-scout-action="duplicate" data-scout-id="p2"(?![^>]*disabled)/);

  const busy = renderScoutProfilesHtml({ profiles: [profile()], now: NOW, busyId: 'p1' });
  assert.match(busy, /data-scout-busy="true" aria-busy="true"/);
  assert.match(busy, /data-scout-action="run" data-scout-id="p1"[^>]*disabled/);
});

test('the inline archive confirmation swaps the row buttons', () => {
  const html = renderScoutProfilesHtml({ profiles: [profile()], now: NOW, confirmArchiveId: 'p1' });
  assert.match(html, /data-scout-action="archive-confirm" data-scout-id="p1"/);
  assert.match(html, /data-scout-action="archive-cancel" data-scout-id="p1"/);
  assert.doesNotMatch(html, /data-scout-action="archive" data-scout-id="p1"/);
});

test('no rendered action is a dead action', () => {
  const html = renderScoutProfilesHtml({
    profiles: [profile(), profile({ id: 'p2', archivedAt: 'x' })],
    now: NOW,
    confirmArchiveId: 'p2',
  });
  const rendered = new Set([...html.matchAll(/data-scout-action="([^"]+)"/g)].map((match) => match[1]));
  assert.ok(rendered.size >= 6, 'the list renders the full management set');
  for (const action of rendered) {
    assert.ok(SCOUT_PROFILE_ACTIONS.includes(action), `${action} is not declared in SCOUT_PROFILE_ACTIONS`);
    assert.ok(settingsSource.includes(`'${action}'`), `the settings panel does not dispatch ${action}`);
  }
  // The panel only dispatches declared actions, so a stale button cannot 404.
  assert.match(settingsSource, /SCOUT_PROFILE_ACTIONS\.includes\(action\)/);
});

test('nextScoutProfileName picks a unique default', () => {
  assert.equal(nextScoutProfileName([]), 'New Scout');
  assert.equal(nextScoutProfileName(['New Scout']), 'New Scout 2');
  assert.equal(nextScoutProfileName(['New Scout', 'New Scout 2']), 'New Scout 3');
  assert.equal(nextScoutProfileName(['Inny']), 'New Scout');
});

test('the settings panel maps each action to the expected server call', () => {
  assert.match(settingsSource, /function bindScoutProfiles\(root\)/);
  assert.match(settingsSource, /async function runScoutProfileAction\(root, action, scoutId\)/);

  // create: POST /profiles, disabled + manual, unique name, no scan start.
  assert.match(
    settingsSource,
    /action === 'create'[\s\S]*?\/api\/workspace-watcher\/scout\/profiles', \{\s*method: 'POST'/,
  );
  assert.match(settingsSource, /nextScoutProfileName\(/);
  assert.match(settingsSource, /enabled: false,[\s\S]*?schedule: \{ mode: 'manual' \}/);

  // duplicate / archive / run hit their REST paths.
  assert.match(settingsSource, /action === 'duplicate'[\s\S]*?\/duplicate`/);
  assert.match(settingsSource, /action === 'archive-confirm'[\s\S]*?\/archive`/);
  assert.match(settingsSource, /action === 'run'[\s\S]*?\/run`/);

  // toggle: PATCH with the full stripped profile and the revision CAS.
  assert.match(settingsSource, /action === 'toggle'[\s\S]*?expectedRevision/);
  assert.match(settingsSource, /stripScoutProfileState\(profile\)/);

  // archive is a local confirmation; cancel clears it without an API call.
  assert.match(settingsSource, /action === 'archive'[\s\S]*?confirmArchiveId/);
  assert.match(settingsSource, /action === 'archive-cancel'[\s\S]*?confirmArchiveId: ''/);

  // reload re-reads the list.
  assert.match(settingsSource, /action === 'reload'[\s\S]*?reloadScoutProfiles\(root\)/);

  // CAS/blocked readability and the mandatory re-fetch.
  assert.match(settingsSource, /res\?\.status === 409/);
  assert.match(settingsSource, /watcherScoutCasConflict/);
  assert.match(settingsSource, /scoutRunResultText\(res\?\.json\)/);
  assert.match(settingsSource, /await reloadScoutProfiles\(root\)/);
});

test('the profile list is fetched once per full render and never blanks the panel', () => {
  assert.match(settingsSource, /\/api\/workspace-watcher\/scout\/profiles'\)\.catch\(\(\) => null\)/);
  assert.match(settingsSource, /function applyScoutProfilesResponse\(res\)/);
  assert.match(settingsSource, /function paintScoutProfiles\(root\)/);
  assert.match(settingsSource, /id="watcher-scout-profiles"/);
  // A failure only replaces the list card (error state), not the whole form.
  assert.match(settingsSource, /settings\.watcherScoutProfilesError/);
  assert.match(readSource('app_front/features/watcher/scoutProfilesView.js'), /data-scout-profiles-error/);
});

test('PL and EN define every new Scout profile key', () => {
  const keys = [
    'watcherScoutProfilesTitle',
    'watcherScoutProfilesHint',
    'watcherScoutProfilesLoading',
    'watcherScoutProfilesError',
    'watcherScoutProfilesEmpty',
    'watcherScoutNew',
    'watcherScoutReload',
    'watcherScoutDuplicate',
    'watcherScoutEnable',
    'watcherScoutDisable',
    'watcherScoutArchive',
    'watcherScoutArchiveConfirm',
    'watcherScoutArchiveConfirmHint',
    'watcherScoutCancel',
    'watcherScoutState_enabled',
    'watcherScoutState_disabled',
    'watcherScoutState_archived',
    'watcherScoutLastRun',
    'watcherScoutNextRun',
    'watcherScoutLimitLabel',
    'watcherScoutNever',
    'watcherScoutNextManual',
    'watcherScoutNextArchived',
    'watcherScoutLimit',
    'watcherScoutPendingCount',
    'watcherScoutRunningCount',
    'watcherScoutCreated',
    'watcherScoutDuplicated',
    'watcherScoutUpdated',
    'watcherScoutArchived',
    'watcherScoutCasConflict',
    'watcherScoutNewDefaultName',
    'watcherScoutNewDefaultObjective',
  ];
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of keys) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});
