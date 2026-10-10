/**
 * CodeBuddy generated memory file with a custom `# Compact instructions`
 * section. Nothing is written unless the operator opts in.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEBUDDY_COMPACT_INSTRUCTIONS_ENV,
  CODEBUDDY_COMPACT_SECTION_HEADING,
  buildCodeBuddyMemoryMarkdown,
  resolveCodeBuddyCompactInstructions,
  writeCodeBuddyMemoryFile,
} from '../lib/codebuddy/codebuddy-memory.js';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-codebuddy-memory-'));

try {
  // Default: nothing generated, nothing written.
  assert.equal(resolveCodeBuddyCompactInstructions({}, {}), '');
  assert.equal(buildCodeBuddyMemoryMarkdown({ compactInstructions: '' }), '');
  const skipped = writeCodeBuddyMemoryFile({ settings: {}, env: {}, homeDir });
  assert.equal(skipped.written, false);
  assert.equal(fs.existsSync(skipped.path), false);

  // Settings opt in and produce the section.
  const fromSettings = writeCodeBuddyMemoryFile({
    settings: { codebuddyCompactInstructions: 'Focus on TypeScript changes and test output.' },
    env: {},
    homeDir,
  });
  assert.equal(fromSettings.written, true);
  assert.ok(fromSettings.path.endsWith(path.join('.codebuddy', 'CODEBUDDY.md')));
  const written = fs.readFileSync(fromSettings.path, 'utf8');
  assert.match(written, /# Compact instructions/);
  assert.match(written, /Focus on TypeScript changes and test output\./);
  assert.equal(written.includes(CODEBUDDY_COMPACT_SECTION_HEADING), true);

  // Env override wins over settings.
  const fromEnv = writeCodeBuddyMemoryFile({
    settings: { codebuddyCompactInstructions: 'settings text' },
    env: { [CODEBUDDY_COMPACT_INSTRUCTIONS_ENV]: 'env text' },
    homeDir,
  });
  assert.match(fromEnv.markdown, /env text/);
  assert.equal(fromEnv.markdown.includes('settings text'), false);

  // Markdown builder shape.
  const markdown = buildCodeBuddyMemoryMarkdown({ compactInstructions: 'keep diffs' });
  assert.ok(markdown.includes(CODEBUDDY_COMPACT_SECTION_HEADING));
  assert.ok(markdown.trimEnd().endsWith('keep diffs'));
} finally {
  fs.rmSync(homeDir, { recursive: true, force: true });
}

console.log('codebuddy-memory.test.js OK');
