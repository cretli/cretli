/**
 * Source-level wiring guards for the shutdown ordering.
 *
 * The manager tests cover behaviour; this pins the server wiring that the
 * acceptance criteria depend on: the synchronous OpenCode phase runs before the
 * browser/delegation teardown, the fatal paths reuse the same cleanup only in
 * production, and the restart script's hard-kill window stays above the manager
 * escalation budget.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENCODE_SHUTDOWN_TOTAL_MS } from '../harnesses/opencode/opencode-server-manager.js';
import { CHILD_PROCESS_SHUTDOWN_TOTAL_MS } from '../lib/child-process-registry.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSource = readFileSync(path.join(projectRoot, 'server.js'), 'utf8');

// --- phase order inside the shutdown handler --------------------------------
const beginIdx = serverSource.indexOf('beginProcessLifecycleStop(');
const finishIdx = serverSource.indexOf('await finishProcessLifecycleStop(');
const childBeginIdx = serverSource.indexOf('beginChildProcessShutdown()');
const childFinishIdx = serverSource.indexOf('await finishChildProcessShutdown()');
const browserIdx = serverSource.indexOf('await browserManager.closeAll');
const delegationIdx = serverSource.indexOf('await shutdownDelegationRuntime(');
assert.ok(beginIdx > 0, 'server.js must call each provider processLifecycle.beginStop');
assert.ok(finishIdx > 0, 'server.js must await each provider processLifecycle.finishStop');
assert.ok(childBeginIdx > 0, 'server.js must call beginChildProcessShutdown');
assert.ok(childFinishIdx > 0, 'server.js must await finishChildProcessShutdown');
assert.ok(browserIdx > 0, 'server.js must close the browser');
assert.ok(delegationIdx > 0, 'server.js must shut the delegation runtime down');
assert.ok(
  beginIdx < childBeginIdx && childBeginIdx < finishIdx && finishIdx < childFinishIdx
    && childFinishIdx < browserIdx && browserIdx < delegationIdx,
  'both synchronous phases and both bounded phases must run before the browser and delegation teardown',
);
assert.ok(serverSource.includes('beginServerShutdown()'), 'new chat runs must be refused from phase 1');
assert.ok(serverSource.includes('beginDelegationShutdown()'), 'new delegations must be refused from phase 1');
assert.ok(serverSource.includes('registerServerDescendants()'), 'phase 1 must adopt SDK-managed harness descendants');
assert.ok(
  /try\s*\{\s*\n\s*registerServerDescendants\(\)/.test(serverSource),
  'descendant discovery must run in its own try block',
);
assert.ok(
  /registerServerDescendants\(\)[\s\S]*?\}\s*catch[\s\S]*?try\s*\{\s*\n\s*childPhaseOne = beginChildProcessShutdown\(\)/.test(serverSource),
  'beginChildProcessShutdown must run even when discovery throws',
);
assert.ok(serverSource.includes('installChildProcessSpawnTracking()'), 'server must register harness CLI children at spawn time');

// --- SIGKILL sweep and periodic discovery are wired at boot ------------------
const childSweepIdx = serverSource.indexOf('await reconcileChildProcessRegistry()');
const listenIdx = serverSource.indexOf('listenOnHosts(server');
assert.ok(childSweepIdx > 0, 'server.js must sweep the child-process registry at startup');
assert.ok(childSweepIdx < listenIdx, 'the child-process sweep must run before the server listens');
assert.ok(serverSource.includes('startChildProcessDiscovery()'), 'server.js must keep the registry close to the live descendants');

// --- fatal paths reuse the same cleanup, only in production -----------------
assert.match(serverSource, /isProd: IS_PROD/, 'the fatal handler must be wired to IS_PROD');
assert.match(
  serverSource,
  /fatalProcessShutdown = \(kind\) => \{[\s\S]*?shutdownDelegationAndExit\(kind, \{ exitCode: 1 \}\)/,
  'the production fatal path must run the shared cleanup',
);
assert.equal(
  (serverSource.match(/if \(outcome\.terminate && !outcome\.shutdownCalled\) process\.exit\(1\);/g) || []).length,
  2,
  'both fatal handlers must fall back to exit(1) only when the cleanup did not run',
);

// --- the shutdown intent is written only for a graceful, scheduled stop -----
assert.ok(
  serverSource.includes('resolveShutdownIntentReason('),
  'the server must decide the shutdown intent reason from the signal and the restart flag',
);
assert.match(
  serverSource,
  /const shutdownIntentReason = resolveShutdownIntentReason\(\{[\s\S]{0,200}?restartScheduled: resolveRestartScheduled\(\)/,
  'the intent reason must consult the explicit scheduled-restart flag, not the signal alone',
);
assert.match(
  serverSource,
  /if \(shutdownIntentReason\) recordShutdownIntent\(\{ signal, reason: shutdownIntentReason \}\);/,
  'a non-graceful/fatal event must write no intent',
);
assert.ok(
  serverSource.indexOf('resolveShutdownIntentReason(') < finishIdx,
  'the intent is written in phase 1, before the bounded OpenCode teardown',
);

// --- the restart script window fits the escalation budget -------------------
const scriptSource = readFileSync(path.join(projectRoot, 'scripts/task-restart-server.sh'), 'utf8');
const sleepMatch = scriptSource.match(/kill \$\{OLD_PID\}[\s\S]*?sleep (\d+)/);
assert.ok(sleepMatch, 'task-restart-server.sh must wait between kill and kill -9');
const hardKillWindowMs = Number(sleepMatch[1]) * 1000;
assert.ok(
  hardKillWindowMs > OPENCODE_SHUTDOWN_TOTAL_MS + CHILD_PROCESS_SHUTDOWN_TOTAL_MS,
  `restart window ${hardKillWindowMs}ms must exceed the combined escalation budget `
    + `${OPENCODE_SHUTDOWN_TOTAL_MS + CHILD_PROCESS_SHUTDOWN_TOTAL_MS}ms`,
);

console.log('server-shutdown-wiring.test.js OK');
