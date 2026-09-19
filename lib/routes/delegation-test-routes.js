/**
 * Isolated E2E control routes. Registered only when CRETLI_TEST_CHAT_RUN_ADAPTER=1.
 * Never enabled on a normal user process.
 */

import { randomUUID } from 'crypto';
import { startChatRun } from '../chat-run-service.js';
import {
  getMockChatRun,
  getMockChatRunStartCount,
  hangNextMockChatRunStart,
  listMockChatRunChatIds,
  patchMockChatRun,
} from '../chat-run/mock-adapter.js';
import { drainChatMailbox } from '../delegation-mailbox.js';
import { noteDelegationRoomEvent } from '../delegation-run-bridge.js';
import { summarizeDelegation } from '../delegation-query.js';
import { getDelegationById } from '../persist/delegations-persist.js';
import { loadMailboxMessages, updateMailboxMessage } from '../persist/delegation-mailbox-persist.js';
import { loadChats } from '../persist/chats-persist.js';

function isTestAdapterEnabled() {
  return String(process.env.CRETLI_TEST_CHAT_RUN_ADAPTER || '') === '1';
}

/**
 * @param {import('express').Express} app
 */
export function registerDelegationTestRoutes(app) {
  if (!isTestAdapterEnabled()) return;

  app.post('/api/test/delegations/hang-next-start', (_req, res) => {
    hangNextMockChatRunStart();
    res.json({ ok: true });
  });

  app.get('/api/test/mock-run/stats', (_req, res) => {
    res.json({
      ok: true,
      startCount: getMockChatRunStartCount(),
      activeChatIds: listMockChatRunChatIds(),
    });
  });

  app.post('/api/test/chats/:id/run', async (req, res) => {
    try {
      const started = await startChatRun({
        chatId: String(req.params.id || ''),
        prompt: String(req.body?.prompt || 'isolated parent hold'),
      });
      res.json({ ok: true, ...started });
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'start_failed';
      res.status(409).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err || 'start_failed'),
        code,
      });
    }
  });

  app.post('/api/test/chats/:id/idle', (req, res) => {
    const chatId = String(req.params.id || '');
    const next = patchMockChatRun(chatId, {
      busy: false,
      waitingForInput: false,
      hold: false,
    });
    res.json({ ok: true, run: next || getMockChatRun(chatId) });
  });

  app.post('/api/test/chats/:id/drain-mailbox', async (req, res) => {
    const result = await drainChatMailbox(String(req.params.id || ''));
    res.json({ ok: true, result });
  });

  app.get('/api/test/chats/:id/mailbox', (req, res) => {
    const chatId = String(req.params.id || '');
    const messages = loadMailboxMessages().filter((row) => (
      String(row.toChatId || '') === chatId || String(row.fromChatId || '') === chatId
    ));
    res.json({
      ok: true,
      messages: messages.map((row) => ({
        id: row.id,
        status: row.status,
        delivery: row.delivery,
        delegationId: row.delegationId,
      })),
    });
  });

  app.get('/api/test/fixtures', (_req, res) => {
    res.json({
      ok: true,
      chats: loadChats().map((row) => ({
        id: row.id,
        title: row.title,
        workspaceFolder: row.workspaceFolder || '',
      })),
    });
  });

  app.post('/api/test/delegations/:id/event', async (req, res) => {
    const row = getDelegationById(String(req.params.id || ''));
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    }
    const kind = String(req.body?.kind || '').trim();
    const room = {
      delegationId: row.id,
      delegationAttemptId: row.attemptId,
      chatId: row.childChatId,
      _currentRunAssistantText: String(req.body?.report || 'isolated report'),
    };
    if (kind === 'waiting_for_input') {
      await noteDelegationRoomEvent(room, {
        type: 'sdkEvent',
        runId: row.runId,
        event: { type: 'tool_call', name: 'AskQuestion', requestId: randomUUID() },
      });
    } else if (kind === 'running') {
      await noteDelegationRoomEvent(room, {
        type: 'opencodeQuestionResolved',
        runId: row.runId,
      });
    } else if (kind === 'finished') {
      patchMockChatRun(row.childChatId, { busy: false, waitingForInput: false, hold: false });
      await noteDelegationRoomEvent(room, {
        type: 'sdkRunFinished',
        runId: row.runId,
        status: String(req.body?.status || 'completed'),
      });
    } else if (kind === 'mailbox_uncertain') {
      const messages = loadMailboxMessages().filter((item) => String(item.delegationId || '') === row.id);
      if (!messages.length) {
        return res.status(409).json({ ok: false, error: 'No mailbox messages to mark uncertain.', code: 'mailbox_missing' });
      }
      for (const message of messages) {
        updateMailboxMessage(message.id, {
          status: 'uncertain',
          delivery: 'uncertain',
          error: 'isolated uncertain delivery',
        });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown event kind.', code: 'unknown_kind' });
    }
    const latest = getDelegationById(row.id) || row;
    const mailbox = loadMailboxMessages().filter((item) => String(item.delegationId || '') === latest.id);
    res.json({ ok: true, delegation: summarizeDelegation(latest, { mailbox }) });
  });
}
