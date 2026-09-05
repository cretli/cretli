import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findSecretLeaksInText,
  scanTrackedFilesForSecrets,
} from '../lib/secret-scan.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.deepEqual(
  findSecretLeaksInText('no secrets here, only ghp_test_token as a fixture name'),
  [],
);

const githubOauthHits = findSecretLeaksInText(
  `token ${'gho_'}${'A'.repeat(36)} in a comment`,
);
assert.equal(githubOauthHits.length, 1);
assert.equal(githubOauthHits[0].id, 'github-oauth');

assert.equal(findSecretLeaksInText('sk-secret-access').length, 0);
assert.equal(findSecretLeaksInText('sk-or-v1-abc123456789').length, 0);

const leaks = scanTrackedFilesForSecrets(projectRoot);
if (leaks.length > 0) {
  const lines = leaks.map((hit) => `${hit.file} [${hit.id}]`);
  assert.fail(`secret scan found live-looking tokens:\n${lines.join('\n')}`);
}

console.log('All secret-scan tests passed.');
