import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runFrontendSmoke } from '../../lib/integration/frontend-smoke.js';
import { runAutomaticIntegration } from '../../lib/integration/auto-integrator.js';

const browserSpec = fs.readFileSync(fileURLToPath(new URL('./frontend.spec.js', import.meta.url)), 'utf8');
assert.match(browserSpec, /await expect\.poll\([\s\S]*UI_smoke_DONE[\s\S]*\)\.toBeTruthy\(\)/,
  'terminal round-trip must be a hard polling assertion');
assert.doesNotMatch(browserSpec, /expect\.configure\(\{\s*soft:\s*true\s*\}\)\.poll/,
  'a soft terminal assertion could let a broken terminal reach publication');

const calls = [];
await runFrontendSmoke({ candidate: '/candidate', execute: async (_node, args, options) => {
  calls.push({ args, options });
  return { stdout: 'ok' };
} });
assert.equal(calls.length, 2);
assert.match(calls[0].args.join(' '), /webpack.*--no-watch/);
assert.match(calls[1].args.join(' '), /playwright.*tests\/ui-smoke\/playwright.config.js/);
assert.equal(calls[1].options.cwd, '/candidate');
assert.equal(fs.existsSync(calls[0].options.env.CRETLI_UI_SMOKE_DIR), false);
for (const failedStage of ['build', 'browser']) {
  let count = 0;
  await assert.rejects(runFrontendSmoke({ candidate: '/candidate', execute: async () => {
    count++;
    if (failedStage === 'build' || count === 2) throw Object.assign(new Error('failure'), { stderr: 'diagnostic' });
    return {};
  } }), (error) => {
    assert.equal(error.code, `frontend_${failedStage}_failed`);
    assert.match(fs.readFileSync(`${error.artifacts}/${failedStage}.log`, 'utf8'), /diagnostic/);
    fs.rmSync(error.artifacts, { recursive: true, force: true });
    return true;
  });
  assert.equal(count, failedStage === 'build' ? 1 : 2);
}
let rejectedReason;
const suspended = [];
const outcome = await runAutomaticIntegration({
  policy: { autoIntegrate: true }, todo: { id: 'smoke', integration: { state: 'ready' } },
  result: { patchPath: 'patch', review: { outcome: 'pass', verified: true } },
  deps: {
    apply: async () => { throw Object.assign(new Error('smoke failed'), { code: 'frontend_browser_failed', artifacts: '/tmp/smoke-artifacts' }); },
    suspendAfterSmokeFailure: async (evidence) => { suspended.push(evidence); return { ok: true }; },
    reject: async ({ reason }) => { rejectedReason = reason; return { ok: true }; },
  },
});
assert.equal(outcome.ok, false);
assert.equal(outcome.rejected, true);
assert.equal(rejectedReason, 'frontend_browser_failed; artifacts: /tmp/smoke-artifacts');
assert.equal(suspended.length, 1);
assert.equal(suspended[0].error.artifacts, '/tmp/smoke-artifacts');

const missingHandler = await runAutomaticIntegration({
  policy: { autoIntegrate: true }, todo: { id: 'smoke', integration: { state: 'ready' } },
  result: { patchPath: 'patch', review: { outcome: 'pass', verified: true } },
  deps: {
    apply: async () => { throw Object.assign(new Error('smoke failed'), { code: 'frontend_browser_failed' }); },
    reject: async () => { throw new Error('must not reject while automation is live'); },
  },
});
assert.equal(missingHandler.suspendError, 'smoke_failure_handler_missing');
assert.equal(missingHandler.rejected, false);

let rejectCalled = false;
const failedPause = await runAutomaticIntegration({
  policy: { autoIntegrate: true }, todo: { id: 'smoke', integration: { state: 'ready' } },
  result: { patchPath: 'patch', review: { outcome: 'pass', verified: true } },
  deps: {
    apply: async () => { throw Object.assign(new Error('smoke failed'), { code: 'frontend_browser_failed' }); },
    suspendAfterSmokeFailure: async () => ({ ok: false, reason: 'watcher_write_failed' }),
    reject: async () => { rejectCalled = true; return { ok: true }; },
  },
});
assert.equal(failedPause.suspendError, 'watcher_write_failed');
assert.equal(failedPause.rejected, false);
assert.equal(rejectCalled, false);
console.log('frontend-smoke.test.js: ok');
