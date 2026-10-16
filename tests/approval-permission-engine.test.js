import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPermissionDecision } from '../lib/approval/permission-decision.js';
import { resolvePermissionPolicyOutcome } from '../lib/approval/permission-engine.js';

const lowBroker = { mode: 'local_reads', risk: 'low', categories: [], delegationRead: false, interactiveRead: false };
const readBroker = { ...lowBroker, interactiveRead: true };
const highBroker = { mode: 'local_reads', risk: 'high', categories: ['secrets'] };
const grant = { harness: 'claude', workspace: '/w', permission: 'bash', effect: 'allow' };
const base = { harness: 'claude', workspace: '/w', permission: 'bash' };

// Hard block beats a user grant and every later stage.
let out = resolvePermissionPolicyOutcome({ ...base, hardBlock: { blocked: true }, grants: [grant], broker: readBroker });
assert.equal(out.state, 'deny');
assert.equal(out.source, 'hard_block');

// User grant beats broker (even a broker ask).
out = resolvePermissionPolicyOutcome({ ...base, grants: [grant], broker: lowBroker });
assert.equal(out.state, 'allow_always');
assert.equal(out.source, 'user_grant');

// User category deny beats a broker allow.
out = resolvePermissionPolicyOutcome({ ...base, settings: { categories: { shell: 'deny' } }, broker: readBroker });
assert.equal(out.state, 'deny');
assert.equal(out.source, 'user_category');

// A user allow never widens a high-risk request.
out = resolvePermissionPolicyOutcome({ ...base, grants: [grant], broker: highBroker });
assert.equal(out.state, 'ask_user');
assert.equal(out.source, 'broker');

// Advisor cannot widen a high-risk ask; first decisive wins.
out = resolvePermissionPolicyOutcome({ ...base, broker: highBroker, advisor: { outcome: 'allow_once' } });
assert.equal(out.state, 'ask_user');
assert.equal(out.reason, 'high_risk_secrets');

// Advisor may narrow a non-high ask to a single allow_once.
out = resolvePermissionPolicyOutcome({ ...base, broker: lowBroker, advisor: { outcome: 'allow_once' } });
assert.equal(out.state, 'allow_once');
assert.equal(out.source, 'advisor');

// Advisor failure -> ask_user.
out = resolvePermissionPolicyOutcome({ ...base, broker: lowBroker, advisor: { failed: true } });
assert.equal(out.state, 'ask_user');
assert.equal(out.source, 'advisor');

// No broker data -> manual card.
out = resolvePermissionPolicyOutcome(base);
assert.equal(out.state, 'ask_user');
assert.equal(out.source, 'manual');

// Invalid state/source fail closed; free-text reason is clamped.
const bad = buildPermissionDecision({ state: 'allow_forever', source: 'broker', reason: 'sure, go ahead' });
assert.equal(bad.state, 'ask_user');
assert.equal(bad.source, 'default');
assert.equal(bad.reply, null);
assert.equal(buildPermissionDecision({ state: 'allow_once', source: 'nope' }).state, 'ask_user');
assert.equal(buildPermissionDecision({ state: 'allow_once', source: 'broker', reason: 'free text' }).reason, 'invalid_reason');
assert.equal(buildPermissionDecision({ state: 'allow_once', source: 'broker', category: 'weird' }).state, 'ask_user');

// Harness neutrality.
const results = ['claude', 'qwen', 'opencode', 'codex', 'deepseek'].map((harness) => {
  const r = resolvePermissionPolicyOutcome({ harness, workspace: '/w', permission: 'bash', broker: readBroker });
  return [r.state, r.source, r.reason].join('|');
});
assert.equal(new Set(results).size, 1);

// Static: neutral modules do not import from lib/opencode.
for (const file of ['permission-decision.js', 'permission-engine.js']) {
  const source = fs.readFileSync(new URL(`../lib/approval/${file}`, import.meta.url), 'utf8');
  assert.equal(/from\s+['"][^'"]*opencode/.test(source), false, file);
  assert.equal(/node:(fs|path)/.test(source), false, file);
}

console.log('approval-permission-engine tests passed');
