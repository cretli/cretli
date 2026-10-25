import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alive, cli, cleanupWorlds, codes, makeWorld, opDirOf, startMarkers, waitFor } from './fixtures/offline-snapshot-helpers.js';

// Quiesced-window hook of the snapshot tool: real child processes, synthetic project only.

afterEach(cleanupWorlds);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Hook script: records whether the server pid was already gone, then exits with the requested code. */
function writeHook(w, { exitCode = 0, proof = null } = {}) {
  const script = path.join(w.root, 'hook.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    'const [pid, out, code] = process.argv.slice(2);',
    'let serverAlive = true;',
    'try { process.kill(Number(pid), 0); serverAlive = !/^[ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1] ?? "X"); } catch { serverAlive = false; }',
    'fs.writeFileSync(out, JSON.stringify({ serverAlive, pid: process.pid, envKeys: Object.keys(process.env).sort() }));',
    `const proof = ${JSON.stringify(proof ?? '')};`,
    "const body = (nonce, outcome) => JSON.stringify({ schema: 'cretli-hook-proof-v1', attempt: nonce, helperOpId: process.env.CRETLI_HOOK_OP_ID, outcome });",
    "if (proof === 'good-legacy') fs.writeFileSync(process.env.CRETLI_HOOK_PROOF_PATH, body(process.env.CRETLI_HOOK_ATTEMPT, 'safe-legacy'));",
    "if (proof === 'good-new') fs.writeFileSync(process.env.CRETLI_HOOK_PROOF_PATH, body(process.env.CRETLI_HOOK_ATTEMPT, 'safe-new'));",
    "if (proof === 'stale') fs.writeFileSync(process.env.CRETLI_HOOK_PROOF_PATH, body('previous-run-nonce', 'safe-legacy'));",
    "if (proof === 'unknown') fs.writeFileSync(process.env.CRETLI_HOOK_PROOF_PATH, body(process.env.CRETLI_HOOK_ATTEMPT, 'half-applied'));",
    "if (proof === 'hang') setInterval(() => {}, 1000);",
    "else process.exit(Number(code));",
    '',
  ].join('\n'));
  const specPath = path.join(w.root, 'spec.json');
  const specText = JSON.stringify({ label: 'unit-hook', script, scriptSha256: sha(fs.readFileSync(script)), args: [String(w.pid), path.join(w.root, 'hook-result.json'), String(exitCode)] });
  fs.writeFileSync(specPath, specText);
  return { script, specPath, specSha: sha(Buffer.from(specText)) };
}

async function hookArgs(w, hook, extra = []) {
  const plan = await cli(w);
  assert.equal(plan.json.ok, true, plan.stdout);
  return ['--apply', '--confirm-stop-all-sessions', '--confirm-identity', plan.json.fingerprint, '--stopped-hook', hook.specPath,
    '--confirm-hook-sha256', hook.specSha, '--restart-verify-ms', '600', '--stop-timeout-ms', '10000', '--descendant-wait-ms', '300', ...extra];
}

describe('snapshot tool stopped-window hook', () => {
  it('runs the pinned hook only after the guarded stop, restarts the service and publishes no archive', async () => {
    const w = await makeWorld();
    const oldPid = w.pid;
    const hook = writeHook(w);
    const res = await cli(w, await hookArgs(w, hook));
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.json.state, 'published');
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.ok(!alive(oldPid));
    const seen = JSON.parse(fs.readFileSync(path.join(w.root, 'hook-result.json'), 'utf8'));
    assert.equal(seen.serverAlive, false, 'the server was stopped before the hook ran');
    assert.ok(!seen.envKeys.some((key) => key.startsWith('FIXTURE_')), 'the hook gets a minimal environment, not the service environment');
    const op = opDirOf(w);
    assert.ok(fs.existsSync(path.join(op, 'hook.out')));
    assert.deepEqual(fs.readdirSync(op).filter((name) => name.endsWith('.tar.gz')), []);
    assert.equal(res.json.archive.hook, 'unit-hook');
  });

  it('--detach carries the pinned hook to the independent helper', async () => {
    const w = await makeWorld();
    const hook = writeHook(w);
    const res = await cli(w, await hookArgs(w, hook, ['--detach']));
    assert.equal(res.code, 0, res.stdout);
    const status = await waitFor(() => {
      const current = JSON.parse(fs.readFileSync(path.join(res.json.operationDir, 'status.json'), 'utf8'));
      return current.state !== 'running' ? current : null;
    }, 60000);
    assert.equal(status.state, 'published', JSON.stringify(status));
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.root, 'hook-result.json'), 'utf8')).serverAlive, false);
    assert.equal(startMarkers(w).length, 2);
  });

  it('a failing hook WITHOUT a durable proof leaves the service stopped (stopped-unsafe) and never respawns it', async () => {
    const w = await makeWorld();
    const hook = writeHook(w, { exitCode: 3 });
    const res = await cli(w, await hookArgs(w, hook));
    assert.notEqual(res.code, 0);
    assert.equal(res.json.state, 'stopped-unsafe');
    assert.equal(res.json.error.code, 'HOOK_FAILED');
    assert.equal(res.json.restart.outcome, 'not-attempted-unsafe');
    assert.match(res.json.recovery.recover.join('\n'), /recover/);
    assert.equal(startMarkers(w).length, 1, 'no second start');
  });

  it('a hook killed by the timeout mid-mutation (no proof) is stopped-unsafe', async () => {
    const w = await makeWorld();
    const hook = writeHook(w, { proof: 'hang' });
    const res = await cli(w, await hookArgs(w, hook, ['--worker-timeout-ms', '1500']));
    assert.equal(res.json.state, 'stopped-unsafe');
    assert.equal(res.json.error.detail?.signal ?? res.json.error.signal, 'SIGKILL');
    assert.equal(startMarkers(w).length, 1);
  });

  it('a stale (other-attempt) or unknown-outcome proof is refused like no proof', async () => {
    for (const proof of ['stale', 'unknown']) {
      const w = await makeWorld();
      const res = await cli(w, await hookArgs(w, writeHook(w, { exitCode: 3, proof })));
      assert.equal(res.json.state, 'stopped-unsafe', proof);
      assert.equal(startMarkers(w).length, 1, proof);
    }
  });

  it('a failed hook with a durable safe-legacy or safe-new proof restarts the service and reports the stable code', async () => {
    for (const proof of ['good-legacy', 'good-new']) {
      const w = await makeWorld();
      const res = await cli(w, await hookArgs(w, writeHook(w, { exitCode: 3, proof })));
      assert.notEqual(res.code, 0, proof);
      assert.equal(res.json.state, 'failed', proof);
      assert.equal(res.json.error.code, 'HOOK_FAILED', proof);
      assert.equal(res.json.restart.outcome, 'running-verified', proof);
      assert.ok(alive(res.json.restart.pid), proof);
    }
  });

  it('refuses before any signal when the spec hash or the script does not match', async () => {
    const w = await makeWorld();
    const hook = writeHook(w);
    const args = await hookArgs(w, hook);
    const wrongSpec = await cli(w, args.map((arg) => (arg === hook.specSha ? 'e'.repeat(64) : arg)));
    assert.ok(codes(wrongSpec.json).includes('HOOK_SPEC_MISMATCH'));
    fs.appendFileSync(hook.script, '// tampered\n');
    const tampered = await cli(w, args);
    assert.ok(codes(tampered.json).includes('HOOK_SCRIPT_MISMATCH'));
    const missing = await cli(w, args.filter((arg, index) => arg !== '--confirm-hook-sha256' && args[index - 1] !== '--confirm-hook-sha256'));
    assert.ok(codes(missing.json).includes('CONFIRM_HOOK_SHA256_MISSING'));
    assert.ok(alive(w.pid), 'no signal was sent');
  });
});
