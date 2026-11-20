/**
 * Scan git-tracked text files for live-looking tokens.
 * Complements CI gitleaks so maintainers can fail locally before a public push.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.pdf',
  '.zip',
  '.gz',
]);

const MAX_FILE_BYTES = 1_000_000;

/** @type {ReadonlyArray<{ id: string, re: RegExp }>} */
const SECRET_PATTERNS = [
  { id: 'github-oauth', re: /\bgho_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-user', re: /\bghu_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat', re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'openai-project', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openrouter', re: /\bsk-or-v1-[a-f0-9]{32,}\b/g },
  { id: 'xai', re: /\bxai-[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'private-key', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
];

const ALLOWED_VALUE = new Set([
  'ghp_test_token',
]);

/**
 * @param {string} text
 * @returns {Array<{ id: string, excerpt: string }>}
 */
export function findSecretLeaksInText(text) {
  const hits = [];
  for (const { id, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match) {
      const excerpt = match[0];
      if (!ALLOWED_VALUE.has(excerpt)) {
        hits.push({ id, excerpt });
      }
      match = re.exec(text);
    }
  }
  return hits;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function listTrackedFiles(root) {
  const output = execFileSync(
    'git',
    ['-c', `safe.directory=${root}`, 'ls-files', '-z'],
    { cwd: root, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 },
  );
  return output.toString('utf8').split('\0').filter(Boolean);
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function shouldSkipPath(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Scan git-tracked files on disk (so uncommitted edits are included).
 *
 * @param {string} root
 * @returns {Array<{ file: string, id: string, excerpt: string }>}
 */
export function scanTrackedFilesForSecrets(root) {
  const files = listTrackedFiles(root);
  const leaks = [];
  for (const relativePath of files) {
    if (shouldSkipPath(relativePath)) continue;
    const absolutePath = path.join(root, relativePath);
    let buffer;
    try {
      buffer = readFileSync(absolutePath);
    } catch {
      continue;
    }
    if (buffer.length > MAX_FILE_BYTES) continue;
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    for (const hit of findSecretLeaksInText(text)) {
      leaks.push({ file: relativePath, ...hit });
    }
  }
  return leaks;
}
