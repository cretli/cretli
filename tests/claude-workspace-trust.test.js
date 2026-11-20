import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-trust-'));
const previousDataDir = process.env.CRETLI_DATA_DIR;
process.env.CRETLI_DATA_DIR = tempDir;

try {
  const { ensureClaudeWorkspaceTrust, withClaudeTrustHint, CLAUDE_TRUST_HINT } = await import('../lib/claude/claude-workspace-trust.ts');
  const { buildClaudeQueryOptions } = await import('../lib/claude/claude-agent-ws.ts');
  const configDir = path.join(tempDir, 'claude-home');
  const cwd = path.join(tempDir, 'worktree', 't-1');
  const file = path.join(configDir, '.claude.json');

  // Creates the file, marks trust, keeps unrelated keys on later calls.
  assert.equal(ensureClaudeWorkspaceTrust(configDir, cwd), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[cwd].hasTrustDialogAccepted, true);
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  existing.oauthAccount = { keep: 'me' };
  existing.projects[cwd].allowedTools = ['x'];
  fs.writeFileSync(file, JSON.stringify(existing));
  const other = path.join(tempDir, 'other');
  assert.equal(ensureClaudeWorkspaceTrust(configDir, other), true);
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(merged.oauthAccount, { keep: 'me' });
  assert.deepEqual(merged.projects[cwd].allowedTools, ['x']);
  assert.equal(merged.projects[other].hasTrustDialogAccepted, true);

  // Idempotent: no rewrite when already trusted; no stray temp files.
  assert.equal(ensureClaudeWorkspaceTrust(configDir, cwd), false);
  assert.deepEqual(fs.readdirSync(configDir), ['.claude.json']);

  // Refuses config dirs outside the data dir and relative cwd; corrupt file untouched.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-outside-'));
  assert.equal(ensureClaudeWorkspaceTrust(outside, cwd), false);
  assert.equal(fs.existsSync(path.join(outside, '.claude.json')), false);
  fs.rmSync(outside, { recursive: true, force: true });
  assert.equal(ensureClaudeWorkspaceTrust(configDir, 'relative/dir'), false);
  fs.writeFileSync(file, '{broken');
  assert.equal(ensureClaudeWorkspaceTrust(configDir, cwd), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');

  // Launch path: building query options pre-accepts trust for the room cwd.
  fs.rmSync(file);
  const launchCwd = path.join(tempDir, 'launch-wt');
  buildClaudeQueryOptions({ cwd: launchCwd, chatId: 'c1' }, 'agent', { env: { CLAUDE_CONFIG_DIR: configDir } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[launchCwd].hasTrustDialogAccepted, true);

  // Hint only when stderr shows the trust warning.
  const trustLine = 'Ignoring 1 permissions.allow entry from .claude/settings.local.json: this workspace has not been trusted';
  assert.match(withClaudeTrustHint('Claude Code process exited with code 143', [trustLine]), new RegExp(CLAUDE_TRUST_HINT.slice(0, 30)));
  assert.equal(withClaudeTrustHint('exited with code 143', ['other']), 'exited with code 143');
} finally {
  if (previousDataDir === undefined) delete process.env.CRETLI_DATA_DIR;
  else process.env.CRETLI_DATA_DIR = previousDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
}
console.log('claude-workspace-trust.test.js OK');
