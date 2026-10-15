/**
 * Delegation settings: key mapping, workspace > env > default precedence,
 * validation (400 on PUT, fallback + source on GET), GET shape, and read-only
 * server-scoped fields.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { resolveDelegationSettings, resolveDelegationSettingsView } from '../lib/delegation-settings.js';
import { DELEGATION_SETTING_DEFS } from '../lib/delegation-settings-schema.js';
import { getDelegationSettings, saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { registerWorkspaceWatcherRoutes } from '../lib/routes/workspace-watcher-routes.js';
import { readDelegationQueueMax } from '../lib/delegation-width.js';
import { readDelegationRunDeadlineImplementMs } from '../lib/delegation-run-deadline.js';
import { tempDir } from './helpers/temp-git-repo.js';

function makeSandbox() {
  return { dataDir: tempDir('cretli-deleg-data-'), workspace: tempDir('cretli-deleg-ws-') };
}

function cleanup(sandbox) {
  fs.rmSync(sandbox.dataDir, { recursive: true, force: true });
  fs.rmSync(sandbox.workspace, { recursive: true, force: true });
}

/** Fake express app that captures route handlers. */
function mountRoutes(sandbox) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'put', 'patch', 'post', 'delete']) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  registerWorkspaceWatcherRoutes(app, { dataDir: sandbox.dataDir, getCurrentCwd: () => sandbox.workspace });
  return async (method, body = {}) => {
    const handler = routes.get(`${method} /api/delegation-settings`);
    assert.ok(handler, `${method} route registered`);
    let status = 200;
    let payload = null;
    const res = {
      status(code) { status = code; return res; },
      json(value) { payload = value; return res; },
    };
    handler({ query: {}, body }, res);
    return { status, body: payload };
  };
}

test('every CRETLI_DELEGATION_* env key maps to exactly one field', () => {
  const envs = DELEGATION_SETTING_DEFS.filter((def) => def.env).map((def) => def.env);
  assert.equal(new Set(envs).size, envs.length);
  const fields = DELEGATION_SETTING_DEFS.map((def) => def.field);
  assert.equal(new Set(fields).size, fields.length);
  for (const key of [
    'RUN_DEADLINE_REVIEW_FIX_MS', 'RUN_DEADLINE_IMPLEMENT_MS', 'CANCELLING_TIMEOUT_MS', 'REVIEW_FANOUT',
    'PARALLEL_IMPLEMENT_FANOUT', 'TREE_SLOT_LIMIT', 'MAX_DEPTH', 'CODE_REVIEW_PHASE', 'CODE_REVIEW_MAX_CLOSURES',
    'EMPTY_FAVORITES', 'REVIEW_ALLOW_UNCERTIFIED', 'GLOBAL_LIMIT', 'QUEUE_MAX',
  ]) {
    assert.ok(envs.includes(`CRETLI_DELEGATION_${key}`), key);
  }
  assert.ok(!envs.includes('CRETLI_DELEGATION_STORE'));
  for (const def of DELEGATION_SETTING_DEFS.filter((d) => d.env)) {
    assert.ok(def.env.startsWith('CRETLI_DELEGATION_'));
  }
});

test('precedence: workspace > env > default', () => {
  const sandbox = makeSandbox();
  try {
    const env = { CRETLI_DELEGATION_TREE_SLOT_LIMIT: '4', CRETLI_DELEGATION_MAX_DEPTH: '3' };
    let view = resolveDelegationSettings({ workspaceFolder: sandbox.workspace, dataDir: sandbox.dataDir, env });
    assert.equal(view.effective.tree_slot_limit, 4);
    assert.equal(view.source.tree_slot_limit, 'env');
    assert.equal(view.source.review_fanout, 'default');
    assert.equal(view.effective.review_fanout, 2);
    saveDelegationSettings(sandbox.workspace, { tree_slot_limit: 9 }, { dataDir: sandbox.dataDir });
    view = resolveDelegationSettings({ workspaceFolder: sandbox.workspace, dataDir: sandbox.dataDir, env });
    assert.equal(view.effective.tree_slot_limit, 9);
    assert.equal(view.source.tree_slot_limit, 'workspace');
    assert.equal(view.envDefault.tree_slot_limit, 4);
    assert.equal(view.env.CRETLI_DELEGATION_TREE_SLOT_LIMIT, '9');
    assert.equal(view.effective.max_depth, 3);
    assert.equal(view.source.max_depth, 'env');
    // Clearing a field falls back to env.
    saveDelegationSettings(sandbox.workspace, { tree_slot_limit: null }, { dataDir: sandbox.dataDir });
    view = resolveDelegationSettings({ workspaceFolder: sandbox.workspace, dataDir: sandbox.dataDir, env });
    assert.equal(view.source.tree_slot_limit, 'env');
  } finally {
    cleanup(sandbox);
  }
});

test('overlay env feeds helpers that take an env argument; no workspace reads env only', () => {
  const sandbox = makeSandbox();
  try {
    saveDelegationSettings(sandbox.workspace, { run_deadline_implement_ms: 1234 }, { dataDir: sandbox.dataDir });
    const resolved = resolveDelegationSettings({ workspaceFolder: sandbox.workspace, dataDir: sandbox.dataDir, env: {} });
    assert.equal(readDelegationRunDeadlineImplementMs(resolved.env), 1234);
    const bare = resolveDelegationSettings({ env: { CRETLI_DELEGATION_QUEUE_MAX: '3' } });
    assert.equal(bare.saved, null);
    assert.equal(readDelegationQueueMax(bare.env), 3);
  } finally {
    cleanup(sandbox);
  }
});

test('invalid saved/env values fall back with the right source', () => {
  const sandbox = makeSandbox();
  try {
    const env = { CRETLI_DELEGATION_REVIEW_FANOUT: 'banana', CRETLI_DELEGATION_QUEUE_MAX: '-4' };
    const view = resolveDelegationSettings({ workspaceFolder: sandbox.workspace, dataDir: sandbox.dataDir, env });
    assert.equal(view.source.review_fanout, 'default');
    assert.equal(view.effective.review_fanout, 2);
    assert.equal(view.source.queue_max, 'default');
    assert.equal(view.effective.queue_max, 8);
    // A hand-edited invalid record is ignored and the env layer wins.
    fs.writeFileSync(
      `${sandbox.dataDir}/delegation-settings.json`,
      JSON.stringify({ v: 1, items: { [fs.realpathSync(sandbox.workspace)]: { tree_slot_limit: 'x', queue_max: 99 } } }),
    );
    const next = resolveDelegationSettings({
      workspaceFolder: sandbox.workspace,
      dataDir: sandbox.dataDir,
      env: { CRETLI_DELEGATION_TREE_SLOT_LIMIT: '2' },
    });
    assert.equal(next.effective.tree_slot_limit, 2);
    assert.equal(next.source.tree_slot_limit, 'env');
    assert.equal(next.effective.queue_max, 8);
  } finally {
    cleanup(sandbox);
  }
});

test('HTTP: PUT with invalid value is 400 and GET keeps the fallback', async () => {
  const sandbox = makeSandbox();
  try {
    const call = mountRoutes(sandbox);
    const bad = await call('PUT', { review_fanout: 7 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);
    const unknown = await call('PATCH', { nope: 1 });
    assert.equal(unknown.status, 400);
    const pairBad = await call('PUT', { reviewer_pair_members: [{ harness: 'a', model: 'b' }] });
    assert.equal(pairBad.status, 400);
    const get = await call('GET');
    assert.equal(get.status, 200);
    assert.equal(get.body.source.review_fanout, 'default');
    assert.equal(get.body.saved, null);
  } finally {
    cleanup(sandbox);
  }
});

test('HTTP: GET response shape and successful PUT', async () => {
  const sandbox = makeSandbox();
  try {
    const call = mountRoutes(sandbox);
    const ok = await call('PUT', {
      workspaceFolder: sandbox.workspace,
      review_fanout: 1,
      reviewer_pair_enabled: true,
      reviewer_pair_members: [{ harness: 'claude', model: 'm1' }, { harness: 'codex', model: 'm2' }],
    });
    assert.equal(ok.status, 200);
    const { body } = await call('GET');
    assert.equal(body.ok, true);
    for (const key of ['effective', 'saved', 'source', 'envDefault']) {
      assert.equal(typeof body[key], 'object', key);
    }
    for (const def of DELEGATION_SETTING_DEFS) {
      assert.ok(def.field in body.effective, def.field);
      assert.ok(['workspace', 'env', 'default'].includes(body.source[def.field]), def.field);
      assert.ok(def.field in body.envDefault, def.field);
    }
    assert.equal(body.effective.review_fanout, 1);
    assert.equal(body.source.review_fanout, 'workspace');
    assert.equal(body.effective.reviewer_pair_enabled, true);
    assert.equal(body.effective.reviewer_pair_members.length, 2);
    assert.equal(body.saved.review_fanout, 1);
  } finally {
    cleanup(sandbox);
  }
});

test('scope=server fields are visible but not writable', async () => {
  const sandbox = makeSandbox();
  try {
    assert.throws(() => saveDelegationSettings(sandbox.workspace, { global_limit: 3 }, { dataDir: sandbox.dataDir }), /server-wide/);
    assert.throws(() => saveDelegationSettings(sandbox.workspace, { queue_max: 3 }, { dataDir: sandbox.dataDir }), /server-wide/);
    assert.equal(getDelegationSettings(sandbox.workspace, { dataDir: sandbox.dataDir }), null);
    const call = mountRoutes(sandbox);
    assert.equal((await call('PUT', { queue_max: 5 })).status, 400);
    const view = resolveDelegationSettingsView({
      workspaceFolder: sandbox.workspace,
      dataDir: sandbox.dataDir,
      env: { CRETLI_DELEGATION_GLOBAL_LIMIT: '6' },
    });
    assert.equal(view.effective.global_limit, 6);
    assert.equal(view.source.global_limit, 'env');
    assert.equal(view.scope.global_limit, 'server');
  } finally {
    cleanup(sandbox);
  }
});

test('model_pick review adapter gate honors the workspace override of env=1', async () => {
  const { buildModelPickFavoriteDiagnosis } = await import('../lib/model-role-profiles.js');
  const workspace = tempDir('cretli-deleg-pick-ws-');
  const previous = process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;
  process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED = '1';
  try {
    const input = {
      role: 'review',
      checkReviewAdapter: true,
      workspaceFolder: workspace,
      harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
      modelsByHarness: { codex: { items: [], favorites_configured: false } },
    };
    const reasons = (value) => buildModelPickFavoriteDiagnosis(value, { checkReviewAdapter: true })
      .rows.flatMap((row) => row.filter_reasons);
    // env=1 and nothing saved: the uncertified harness is allowed.
    assert.ok(!reasons(input).includes('review-adapter-blocked'));
    saveDelegationSettings(workspace, { review_allow_uncertified: false });
    const { resolveDelegationEnv } = await import('../lib/delegation-settings.js');
    assert.equal(resolveDelegationEnv(workspace).CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED, '0');
    assert.ok(reasons(input).includes('review-adapter-blocked'));
  } finally {
    if (previous === undefined) delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;
    else process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
