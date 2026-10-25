/**
 * Regression: the work-session resume suite must not read a host-level
 * data/delegation-settings.json, even one that enables every reuse switch.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const target = new URL('./delegation-work-session-resume-service.test.js', import.meta.url).pathname;
const spy = new URL('./fixtures/spy-delegation-settings-reads.cjs', import.meta.url).pathname;

function runWith(globalDir, store) {
  const log = path.join(globalDir, 'reads.log');
  const env = { ...process.env, CRETLI_DATA_DIR: globalDir, CURSOR_REMOTE_DATA_DIR: globalDir, SPY_SETTINGS_LOG: log };
  if (store) env.CRETLI_DELEGATION_STORE = store;
  else delete env.CRETLI_DELEGATION_STORE;
  // A parent runner context would make the child skip real execution.
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require ${spy}`.trim();
  const run = spawnSync(process.execPath, [target], { env, encoding: 'utf8' });
  const reads = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { run, reads };
}

for (const populated of [true, false]) {
  for (const store of ['', 'json']) {
    test(`global settings ${populated ? 'populated' : 'empty'}, store=${store || 'default'}: suite passes and never reads them`, () => {
      const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-global-data-'));
      try {
        const file = path.join(globalDir, 'delegation-settings.json');
        const body = populated
          ? JSON.stringify({
            v: 1,
            items: {
              [globalDir]: {
                continue_plan_sessions: true,
                continue_implement_sessions: true,
                continue_fix_sessions: true,
                plan_session_scope: 'orchestrator',
                implement_session_scope: 'orchestrator',
                fix_session_scope: 'orchestrator',
              },
            },
          })
          : '{}';
        fs.writeFileSync(file, body);
        const { run, reads } = runWith(globalDir, store);
        assert.equal(run.status, 0, run.stdout.slice(-2000) + run.stderr.slice(-1000));
        assert.deepEqual(reads.filter((p) => path.dirname(p) === globalDir), []);
        assert.ok(reads.length > 0, 'spy saw the suite read its own isolated settings');
        assert.equal(fs.readFileSync(file, 'utf8'), body, 'global file untouched');
      } finally {
        fs.rmSync(globalDir, { recursive: true, force: true });
      }
    });
  }
}
