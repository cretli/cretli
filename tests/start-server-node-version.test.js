import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'start-server-node22.sh');

/**
 * A stub `node` that answers like a coloured Node 22.10: `-p` wraps numbers in
 * ANSI codes (as real Node does under FORCE_COLOR), `-e` writes plain text.
 */
function makeStubNode(dir) {
  const stub = path.join(dir, 'node');
  fs.writeFileSync(stub, `#!/bin/bash
case "$1" in
  -v) echo v22.10.0 ;;
  -p) if [[ "$2" == *"[0]"* ]]; then printf '\\033[33m22\\033[39m\\n'; else printf '\\033[33m10\\033[39m\\n'; fi ;;
  -e) if [[ "$2" == *"[0]"* ]]; then printf 22; else printf 10; fi ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
}

test('version gate parses the Node version even when FORCE_COLOR colourises output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-node-stub-'));
  try {
    makeStubNode(dir);
    const res = spawnSync('bash', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: `${dir}:/usr/bin:/bin`, FORCE_COLOR: '1', HOME: os.tmpdir() },
      timeout: 20000,
    });
    assert.equal(res.status, 1);
    assert.doesNotMatch(res.stderr, /syntax error/);
    assert.match(res.stderr, /Node\.js v22\.10\.0 detected; Cretli needs >= 22\.18/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
