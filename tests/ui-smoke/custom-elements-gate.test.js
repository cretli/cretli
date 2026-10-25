import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIntegrationGates } from '../../lib/integration/git-integrator.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-registration-gate-'));
const candidate = path.join(scratch, 'candidate');
const baseline = path.join(scratch, 'baseline');
const registrationTest = 'tests/custom-elements-imported.test.js';
const calls = [];
const input = { candidate, baseline, files: ['app_front/deleted.js'], frontendSmoke: async (value) => calls.push(value.candidate) };
try {
  fs.mkdirSync(path.join(candidate, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(baseline, 'tests'), { recursive: true });
  await assert.rejects(runIntegrationGates(input), { code: `required_gate_missing:${registrationTest}` });
  for (const folder of [candidate, baseline]) {
    fs.writeFileSync(path.join(folder, registrationTest), 'process.exit(1);');
  }
  // An identical broken baseline must not excuse a missing registration.
  await assert.rejects(runIntegrationGates(input), { code: `test_failed:${registrationTest}` });
  assert.deepEqual(calls, []);
  fs.writeFileSync(path.join(candidate, registrationTest), 'process.exit(0);');
  await runIntegrationGates(input);
  assert.deepEqual(calls, [candidate]);
  await assert.rejects(runIntegrationGates({ ...input, frontendSmoke: async () => { throw new Error('browser failed'); } }), /browser failed/);
  fs.rmSync(path.join(candidate, registrationTest));
  await runIntegrationGates({ ...input, files: [] });
  assert.deepEqual(calls, [candidate]);
  console.log('custom-elements-gate.test.js: ok');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
