/**
 * Pure editor model for the audited Settings → Harness model-role panel.
 *
 * The delta computation must be order-independent and only emit rules that
 * differ from the policy baseline; the renderer must surface locked roles,
 * preserved matchers and the server-computed diff (including the invalid state).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelRoleConfigViewModel,
  computeModelRoleConfigDelta,
  computeRoleDelta,
  renderModelRoleConfigDiffHtml,
  renderModelRoleConfigHtml,
} from '../app_front/features/harness-health/harnessModelRoleConfigModel.js';

/**
 * @param {string} key
 * @param {object} [values]
 * @returns {string}
 */
function t(key, values = {}) {
  return String(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
}

const SNAPSHOT = {
  ok: true,
  state: 'valid',
  error: null,
  etag: 'abcdef0123456789',
  roles: {
    plan: {
      locked: false,
      legacyOverride: true,
      policy: ['grok', 'luna', 'sol'],
      policyRules: [
        { pattern: 'grok', priority: 0 },
        { pattern: 'luna', priority: 1 },
        { pattern: 'sol', priority: 2 },
      ],
      rules: [
        { pattern: 'luna', priority: 0, source: 'operator' },
        { pattern: 'sol', priority: 2, source: 'operator' },
      ],
      preserved: [],
    },
    implement: {
      locked: true,
      legacyOverride: false,
      policy: [],
      policyRules: [],
      rules: [],
      preserved: [{ pattern: 'sub:sol', mode: 'sub', deny: false, reason: 'sub' }],
    },
    review: {
      locked: false,
      legacyOverride: false,
      policy: ['grok'],
      policyRules: [{ pattern: 'grok', priority: 0 }],
      rules: [{ pattern: 'grok', priority: 0, source: 'policy' }],
      preserved: [],
    },
    fix: {
      locked: false,
      legacyOverride: false,
      policy: ['flash'],
      policyRules: [{ pattern: 'flash', priority: 0 }],
      rules: [{ pattern: 'flash', priority: 0, source: 'policy' }],
      preserved: [],
    },
  },
  rotation: { mode: 'balanced', band: 0.05 },
  defaultRotation: { mode: 'balanced', band: 0.05 },
  adaptive: { enabled: true },
  defaultAdaptive: { enabled: true },
  weights: { plan: { cost: 0.2, quality: 0.65, speed: 0.15 } },
  defaultWeights: { plan: { cost: 0.2, quality: 0.65, speed: 0.15 } },
  unknownTopLevelKeys: ['custom'],
};

test('the editable view marks checked rules, policy priors and unknown keys', () => {
  const model = buildModelRoleConfigViewModel(SNAPSHOT, t);
  const plan = model.roles.find((row) => row.role === 'plan');
  assert.deepEqual(plan.options.map((row) => [row.pattern, row.checked, row.priority]), [
    ['grok', false, 0],
    ['luna', true, 0],
    ['sol', true, 2],
  ]);
  assert.equal(plan.legacyOverride, true);
  assert.deepEqual(model.unknownTopLevelKeys, ['custom']);
  assert.equal(model.etag, 'abcdef0123456789');
});

test('a locked role exposes its preserved matchers and no options', () => {
  const model = buildModelRoleConfigViewModel(SNAPSHOT, t);
  const implement = model.roles.find((row) => row.role === 'implement');
  assert.equal(implement.locked, true);
  assert.deepEqual(implement.options, []);
  assert.equal(implement.preserved[0].pattern, 'sub:sol');
});

test('computeRoleDelta emits only priority/existence changes and is order independent', () => {
  const forward = computeRoleDelta({
    policy: SNAPSHOT.roles.plan.policyRules,
    desired: [{ pattern: 'luna', priority: 0 }, { pattern: 'sol', priority: 2 }, { pattern: 'grok', priority: 0 }],
  });
  const reverse = computeRoleDelta({
    policy: SNAPSHOT.roles.plan.policyRules,
    desired: [{ pattern: 'grok', priority: 0 }, { pattern: 'sol', priority: 2 }, { pattern: 'luna', priority: 0 }],
  });
  assert.deepEqual(forward, { set: { luna: { priority: 0 } } });
  assert.deepEqual(forward, reverse);
});

test('computeRoleDelta removes a policy rule that is no longer desired', () => {
  const delta = computeRoleDelta({
    policy: SNAPSHOT.roles.plan.policyRules,
    desired: [{ pattern: 'sol', priority: 2 }],
  });
  assert.deepEqual(delta, { remove: ['grok', 'luna'] });
});

test('computeRoleDelta returns null for an unchanged role', () => {
  const delta = computeRoleDelta({
    policy: SNAPSHOT.roles.plan.policyRules,
    desired: SNAPSHOT.roles.plan.policyRules,
  });
  assert.equal(delta, null);
});

test('computeModelRoleConfigDelta skips locked roles and includes tuning changes', () => {
  const model = buildModelRoleConfigViewModel(SNAPSHOT, t);
  const delta = computeModelRoleConfigDelta({
    model,
    desired: {
      roles: {
        plan: [{ pattern: 'luna', priority: 0 }, { pattern: 'sol', priority: 2 }],
        implement: [{ pattern: 'flash', priority: 0 }],
      },
      rotation: { mode: 'off', band: 0.05 },
      adaptive: { enabled: true },
    },
  });
  assert.deepEqual(delta, {
    roles: { plan: { set: { luna: { priority: 0 } }, remove: ['grok'] } },
    rotation: { mode: 'off', band: 0.05 },
  });
});

test('the editor renders every role, checkbox, tuning control and the state badge', () => {
  const model = buildModelRoleConfigViewModel(SNAPSHOT, t);
  const html = renderModelRoleConfigHtml(model, t);
  assert.match(html, /data-role="plan"/);
  assert.match(html, /data-pattern="grok"/);
  assert.match(html, /data-field="rotation-mode"/);
  assert.match(html, /data-field="adaptive-enabled"/);
  assert.match(html, /harnessModelRole\.stateBadge/);
  assert.match(html, /harnessModelRole\.roleLocked/);
  assert.match(html, /sub:sol/);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{6}/);
});

test('the explore policy is shown read-only', () => {
  const model = buildModelRoleConfigViewModel({ ...SNAPSHOT, explore: { mode: 'dry-run' } }, t);
  const html = renderModelRoleConfigHtml(model, t);
  assert.match(html, /harnessModelRole\.exploreReadOnly/);
  assert.equal(model.explore.mode, 'dry-run');
});

test('an invalid config is surfaced as an alert in the editor', () => {
  const model = buildModelRoleConfigViewModel({ ...SNAPSHOT, state: 'invalid', error: 'invalid JSON: boom' }, t);
  const html = renderModelRoleConfigHtml(model, t);
  assert.match(html, /harnessModelRole\.configInvalid/);
  assert.match(html, /invalid JSON: boom/);
});

test('the diff renderer shows added, removed and updated rules', () => {
  const html = renderModelRoleConfigDiffHtml({
    changed: true,
    blocked: false,
    roles: {
      plan: {
        added: [{ pattern: 'flash', priority: 1 }],
        removed: [{ pattern: 'grok', priority: 0 }],
        updated: [{ pattern: 'luna', from: 1, to: 0 }],
      },
    },
    rotation: { from: { mode: 'balanced' }, to: { mode: 'off' } },
  }, t);
  assert.match(html, /\+ flash/);
  assert.match(html, /− grok/);
  assert.match(html, /~ luna 1→0/);
  assert.match(html, /balanced → off/);
});

test('the diff renderer shows a no-op and a blocked state', () => {
  assert.match(renderModelRoleConfigDiffHtml({ changed: false, blocked: false, roles: {} }, t), /harnessModelRole\.diffNone/);
  assert.match(renderModelRoleConfigDiffHtml({ changed: false, blocked: true, roles: {} }, t), /harnessModelRole\.diffBlocked/);
});
