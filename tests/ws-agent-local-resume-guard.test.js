/**
 * BE7 regression tests: the legacy /ws-agent?resume= branch must reject a chat
 * whose persisted transport is a local plugin id before handlePtyConnection can
 * forward that id to the CLI as --resume (pty-ws-handler.js appends
 * `--resume <resumeId>` verbatim). The close must reuse the existing
 * unsupported-resume code 4000 with a short static reason free of filesystem
 * paths, and every built-in resume behavior must stay intact.
 *
 * Source-scan style matches the existing ws-router guard tests
 * (local-harness-runtime, builtin-harness-providers); no server, no PTY spawn.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const WS_ROUTER_SOURCE = readFileSync(new URL('../lib/ws/ws-router.js', import.meta.url), 'utf8');

function legacyResumeBranch() {
  const start = WS_ROUTER_SOURCE.indexOf("const isAgent = urlPath === '/ws-agent'");
  assert.ok(start > 0, 'the legacy /ws-agent branch must exist');
  const ptyIndex = WS_ROUTER_SOURCE.indexOf('handlePtyConnection(', start);
  assert.ok(ptyIndex > start, 'handlePtyConnection must run after the legacy resume guard');
  return WS_ROUTER_SOURCE.slice(start, ptyIndex);
}

test('legacy /ws-agent resume closes local plugin chats with 4000 before the PTY handler', () => {
  const branch = legacyResumeBranch();

  const lookupIndex = branch.indexOf('const chat = getChatByCursorSessionId(resumeId);');
  assert.ok(lookupIndex > 0, 'the guard must key off the chat resolved from the resume id');

  const guardIndex = branch.indexOf("rawHarnessTransportKind(chat.agentTransport) === 'local'");
  assert.ok(
    guardIndex > lookupIndex,
    'the legacy branch must explicitly check rawHarnessTransportKind(chat.agentTransport) for local ids',
  );
  const localResumeGateIndex = branch.indexOf('if (isAgent && resumeId) {');
  const builtinResumeGateIndex = branch.indexOf('if (!agentRunName && chat &&');
  assert.ok(
    localResumeGateIndex >= 0 && localResumeGateIndex < guardIndex && guardIndex < builtinResumeGateIndex,
    'the local resume guard must run even when agentRun is present; only the built-in guard keeps that bypass',
  );

  const closeIndex = branch.indexOf('ws.close(4000', guardIndex);
  assert.ok(closeIndex > guardIndex, 'a local chat must be closed with the unsupported-resume code 4000');

  const closeWindow = branch.slice(closeIndex, closeIndex + 160);
  assert.doesNotMatch(
    closeWindow,
    /`|process\.|ctx\.|__dirname|require\(/,
    'the close reason must be a static safe string, not built from paths or runtime values',
  );
  const closeCall = /ws\.close\(4000,\s*'([^']*)'\)/.exec(closeWindow);
  assert.ok(closeCall, 'the close must pass a plain single-quoted reason');
  const reason = closeCall[1];
  assert.ok(reason.length > 0 && reason.length <= 123, 'the close reason must fit the ws 123-byte limit');
  assert.doesNotMatch(
    reason,
    /(^|\s)~|\.\.\//i,
    'the close reason must not expose filesystem locations',
  );

  const returnIndex = branch.indexOf('return;', closeIndex);
  assert.ok(returnIndex > closeIndex, 'the local guard must return before falling through');
});

test('built-in legacy resume behavior stays intact (lock)', () => {
  const branch = legacyResumeBranch();

  // Known harness chats still close with 4000 and the branch still skips the
  // guard for agent-run resumes, preserving built-in CLI resume behavior.
  assert.ok(branch.indexOf('isSdkChat(chat)') > 0);
  assert.ok(branch.indexOf('isClaudeChat(chat)') > 0);
  assert.ok(branch.indexOf("ws.close(4000, 'Chats use harness WebSocket (/ws-agent-sdk).')") > 0);
  assert.ok(branch.indexOf('!agentRunName') > 0);

  // The /ws-agent-sdk reconnect path keeps routing local ids to the plugin
  // runtime ahead of the SDK catch-all.
  const sdkGuardIndex = WS_ROUTER_SOURCE.indexOf(
    "rawHarnessTransportKind(routedChat.agentTransport) === 'local'",
  );
  const sdkDispatchIndex = WS_ROUTER_SOURCE.indexOf(
    'dispatchLocalHarnessWebSocket(ws, sessionKey, routedChat)',
  );
  assert.ok(sdkGuardIndex > 0 && sdkDispatchIndex > sdkGuardIndex);
});

console.log('ws-agent-local-resume-guard.test.js OK');
