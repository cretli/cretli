import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousDataDir = process.env.CRETLI_DATA_DIR;
const previousAnthropic = process.env.ANTHROPIC_API_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-session-reset-'));
process.env.CRETLI_DATA_DIR = tempDir;
delete process.env.ANTHROPIC_API_KEY;

const { addChat, loadChats } = await import('../lib/persist/chats-persist.js');
const {
  clearClaudeRoomSession,
  isClaudeResumeFailure,
  shouldRetryClaudeRunWithoutResume,
} = await import('../lib/claude/claude-agent-ws.js');

const SDK_SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

try {
  // Positive: exact CLI and SDK resume-failure texts.
  assert.equal(
    isClaudeResumeFailure(`No conversation found with session ID: ${SDK_SESSION_ID}`),
    true,
  );
  assert.equal(isClaudeResumeFailure('No conversation found to continue'), true);
  assert.equal(isClaudeResumeFailure(`Session ${SDK_SESSION_ID} not found`), true);
  assert.equal(
    isClaudeResumeFailure(`Session ${SDK_SESSION_ID} not found in any project directory`),
    true,
  );
  assert.equal(
    isClaudeResumeFailure(`Session ${SDK_SESSION_ID} not found (no projects directory)`),
    true,
  );
  assert.equal(isClaudeResumeFailure(`Session ${SDK_SESSION_ID} was not found`), true);

  // Negative: unrelated "not found"/limit errors must not drop a healthy session.
  assert.equal(isClaudeResumeFailure('Resumed session abc: config file not found'), false);
  assert.equal(isClaudeResumeFailure('session token was not found'), false);
  assert.equal(isClaudeResumeFailure('file not found'), false);
  assert.equal(isClaudeResumeFailure('Session limit reached'), false);
  assert.equal(isClaudeResumeFailure('Session abc not found'), false);
  assert.equal(isClaudeResumeFailure(''), false);
  assert.equal(isClaudeResumeFailure('rate limit exceeded'), false);
  assert.equal(isClaudeResumeFailure('connection reset by peer'), false);
  assert.equal(isClaudeResumeFailure(null), false);

  const staleAttempt = {
    attempt: 1,
    useResume: true,
    status: 'error',
    cancelled: false,
    errorMessage: `No conversation found with session ID: ${SDK_SESSION_ID}`,
  };
  assert.equal(shouldRetryClaudeRunWithoutResume(staleAttempt), true);
  assert.equal(shouldRetryClaudeRunWithoutResume({ ...staleAttempt, attempt: 2 }), false);
  assert.equal(shouldRetryClaudeRunWithoutResume({ ...staleAttempt, useResume: false }), false);
  assert.equal(shouldRetryClaudeRunWithoutResume({ ...staleAttempt, status: 'completed' }), false);
  assert.equal(shouldRetryClaudeRunWithoutResume({ ...staleAttempt, cancelled: true }), false);
  assert.equal(shouldRetryClaudeRunWithoutResume({ ...staleAttempt, errorMessage: 'boom' }), false);
  assert.equal(shouldRetryClaudeRunWithoutResume(), false);

  const chat = addChat(
    'cursor-session-reset',
    'Reset',
    undefined,
    tempDir,
    'claude-sonnet-4-5',
    { claudeSessionId: 'stale-session-id' },
  );
  assert.equal(chat.claudeSessionId, 'stale-session-id');

  const room = { chatId: chat.id, claudeSessionId: 'stale-session-id' };
  clearClaudeRoomSession(room);
  assert.equal(room.claudeSessionId, '');
  const stored = loadChats().find((entry) => entry.id === chat.id);
  assert.equal(stored && stored.claudeSessionId, undefined);

  // A room without chatId must still clear its in-memory id.
  const detached = { claudeSessionId: 'stale-2' };
  clearClaudeRoomSession(detached);
  assert.equal(detached.claudeSessionId, '');
} finally {
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  if (typeof previousAnthropic === 'string') process.env.ANTHROPIC_API_KEY = previousAnthropic;
  else delete process.env.ANTHROPIC_API_KEY;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('claude-session-reset.test.js OK');
