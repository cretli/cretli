import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Enforces .cursor/rules/no-private-environment.mdc: the public repo carries
// only generic examples. Machine-, client- and network-specific values belong
// in local settings, never in tracked files.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = /(^|\/)(package-lock\.json|CHANGELOG\.md)$|\.(png|jpe?g|webp|ico|gif|woff2?|ttf|gz|zip|mp3|wav|pdf)$/i;
const GENERIC_HOME_NAMES = new Set([
  'alice', 'user', 'me', 'someone', 'you', 'x', 'u', 'secret', 'projects', 'w', 'runner', 'example', 'example-user', 'maintainer', 'name', 'username',
]);
// Extra literals to forbid (client names, hostnames, your username), comma
// separated. Set it locally so the repo itself never names them.
const EXTRA = String(process.env.CRETLI_PRIVATE_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean);

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 28 }).toString('utf8');
  return out.split('\0').filter((file) => file && !SKIP.test(file));
}

describe('public repo carries no private environment data', () => {
  const files = trackedTextFiles();
  const sources = new Map();
  for (const file of files) {
    try {
      sources.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    } catch {
      // Deleted in the working tree or unreadable: nothing to scan.
    }
  }

  it('has no home directory of a real user', () => {
    const hits = [];
    for (const [file, text] of sources) {
      for (const match of text.matchAll(/\/home\/([A-Za-z0-9._-]+)\//g)) {
        if (!GENERIC_HOME_NAMES.has(match[1])) hits.push(`${file}: ${match[0]}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('has no private LAN address beyond the 192.168.0/1 documentation examples, and no NAS vendor names', () => {
    const pattern = /192\.168\.(?!0\.|1\.)\d+\.\d+|Synology|DiskStation/;
    const hits = [];
    for (const [file, text] of sources) {
      if (file === '.cursor/rules/no-private-environment.mdc' || file === 'tests/browser-runtime-doc.test.js' || file === 'tests/todo-review-backfill.test.js' || file === 'tests/no-private-environment.test.js') continue;
      if (pattern.test(text)) hits.push(file);
    }
    assert.deepEqual(hits, []);
  });

  it('has none of the locally configured private tokens', { skip: EXTRA.length === 0 && 'set CRETLI_PRIVATE_TOKENS to check names that must not be committed' }, () => {
    const hits = [];
    for (const [file, text] of sources) {
      for (const token of EXTRA) {
        if (text.toLowerCase().includes(token.toLowerCase())) hits.push(`${file}: ${token}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
