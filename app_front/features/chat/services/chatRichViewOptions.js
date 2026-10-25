/**
 * Option bag for the SDK rich view of a chat pane (history, delegation and queue callbacks).
 */
import { isRelatedChatLinkVisible } from '../../../../lib/chat-tree.js';
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { showChoiceDialog } from '../../../lib/choiceDialog.js';
import { appLogger } from '../../../core/logging/logger.js';
import { resolveAcceptErrorKey } from '../../todo/todoReviewBadge.js';
import { getChatSpeaker } from '../../voice/chatSpeaker.js';
import {
  clearDelegationIdempotencyKey,
  hashTextSha256,
  peekDelegationIdempotencyKey,
} from '../chatDelegations.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { openNewChatModal } from '../views/newChatModal.js';
import { syncSdkHistoryOnResume } from './chatHistorySync.js';
import { loadChatsFromServer, selectChat } from './chatSelection.js';
import { patchChatTitle, processAgentOutput } from './chatTitlesOutput.js';
import {
  enqueueSdkStructuredHistoryRecord,
  loadOlderSdkHistoryPage,
  sendOpenCodePermissionReply,
  sendOpenCodeQuestionReply,
  sendQueueControl,
} from './sdkHistoryQueue.js';

/**
 * Callbacks handed to createSdkRichView for one chat.
 * @param {any} chat
 * @returns {Record<string, any>}
 */
export function buildChatRichViewOptions(chat) {
  return {
    appendPlain: (s) => {
      if (!chat.term) return;
      processAgentOutput(chat, s);
    },
    onHistoryRecord: (rec) => enqueueSdkStructuredHistoryRecord(chat, rec),
    loadOlderHistory: () => loadOlderSdkHistoryPage(chat),
    resolveTodoRow: (todoId) => import('../../todo/index.js').then((mod) => mod.loadTodoSummary(todoId)),
    onFinishTitle: (title) => {
      patchChatTitle(chat, title, {
        source: 'finish-summary',
        logLabel: 'auto-title (finish summary):',
      });
    },
    onAssistantText: (text) => {
      // Only the chat on screen talks; background runs would overlap voices.
      if (chat.id === chatRuntime.activeChatId) getChatSpeaker().handleAssistantText(text);
    },
    onAnswerEnd: () => {
      if (chat.id === chatRuntime.activeChatId) getChatSpeaker().endAnswer();
    },
    onForceSendQueueItem: (text) => sendQueueControl(chat, 'queueForceSend', text),
    onRemoveQueueItem: (text) => sendQueueControl(chat, 'queueRemove', text),
    onForkFromPoint: ({ createdAt }) => {
      const point = typeof createdAt === 'string' ? createdAt.trim() : '';
      if (!point || !chat?.id) return;
      openNewChatModal({
        forkFromChatId: chat.id,
        upToCreatedAt: point,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
    },
    onPassMessageToChild: (point) => {
      if (!chat?.id || !point?.text) return;
      openNewChatModal({
        passMessageFromChatId: chat.id,
        historySeq: point.historySeq,
        createdAt: point.createdAt,
        text: point.text,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
    },
    onReplyMessageToParent: (point) => {
      if (!chat?.id || !point?.text) return;
      if (chat._mailboxReplyBusy) return;
      const parentId = String(chat.delegationParentChatId || '').trim();
      const parent = parentId ? chats.find((row) => row.id === parentId) : null;
      const key = peekDelegationIdempotencyKey(`${chat.id}:reply:${point.historySeq || point.createdAt || point.text.slice(0, 24)}`);
      void (async () => {
        const choice = await showChoiceDialog({
          heading: t('chat.mailboxReplyPreviewHeading'),
          body: t('chat.mailboxReplyPreviewBody', { parent: parent?.title || parentId || '—' }),
          cancelLabel: t('chat.cancel'),
          options: [{ value: 'send', label: t('chat.mailboxReplySend'), variant: 'primary' }],
        });
        if (choice !== 'send' && choice?.value !== 'send') return;
        chat._mailboxReplyBusy = true;
        try {
          const contentHash = await hashTextSha256(point.text);
          const res = await api.postChatMailboxReply(chat.id, {
            historySeq: point.historySeq,
            contentHash,
            textSnapshot: point.text,
            idempotencyKey: key,
          });
          if (res?.ok && !res.replayed) {
            clearDelegationIdempotencyKey(`${chat.id}:reply:${point.historySeq || point.createdAt || point.text.slice(0, 24)}`);
          }
          if (!res?.ok) {
            alert(res?.error || t('chat.mailboxReplyFailed'));
            return;
          }
          chat._sdkRichView?.appendMetaNotice?.(t('chat.mailboxReplySent', {
            parent: parent?.title || parentId || '—',
          }));
        } catch {
          alert(t('chat.serverConnectionError'));
        } finally {
          chat._mailboxReplyBusy = false;
        }
      })();
    },
    onOpenCodeQuestionReply: (payload) => sendOpenCodeQuestionReply(chat, payload),
    onOpenCodePermissionReply: (payload) => sendOpenCodePermissionReply(chat, payload),
    onOpenDelegationChat: (childChatId) => {
      if (!childChatId) return;
      void (async () => {
        if (!chats.some((entry) => entry.id === childChatId)) {
          await loadChatsFromServer({ skipAutoSelect: true, preferChatId: childChatId });
        }
        selectChat(childChatId, { byUser: true });
      })().catch((error) => {
        appLogger.log('delegation', 'open executor failed', { error: String(error) });
      });
    },
    isRelatedChatVisible: (relatedChatId) => isRelatedChatLinkVisible(chats, relatedChatId),
    onCancelDelegation: (delegationId) => {
      if (!delegationId) return;
      void api.postDelegationCancel(delegationId);
    },
    onAcknowledgeDelegation: (delegationId) => {
      if (!delegationId) return;
      void api.postDelegationAck(delegationId, { reason: 'reviewed' }).then((res) => {
        if (!res?.ok) return;
        if (chat._sdkHistoryHydrating) return;
        void syncSdkHistoryOnResume(chat, { reason: 'delegation_ack' }).catch(() => {});
      }).catch(() => {});
    },
    onLoadDelegationAcceptContext: (delegationId) => {
      if (!delegationId) return Promise.resolve({ ok: false });
      return api.getDelegationAcceptContext(delegationId);
    },
    onAcceptDelegation: (delegationId, payload) => {
      if (!delegationId) return Promise.resolve({ ok: false });
      return api.postDelegationAccept(delegationId, {
        attemptId: payload?.attemptId || '',
        // Sent exactly as pinned when the card appeared; '' means the card saw
        // "unavailable", which the server must not treat as "omitted" (§6.3).
        materialRevision: String(payload?.materialRevision ?? ''),
        todoRevision: String(payload?.todoRevision ?? ''),
      }).then((res) => {
        if (res?.ok) {
          if (!chat._sdkHistoryHydrating) {
            void syncSdkHistoryOnResume(chat, { reason: 'delegation_accept' }).catch(() => {});
          }
          return res;
        }
        return { ...(res || {}), ok: false, errorKey: resolveAcceptErrorKey(res) };
      });
    },
    onRetryDelegation: (delegationId) => {
      if (!delegationId) return;
      void api.postDelegationRetry(delegationId).then((res) => {
        if (res?.ok) {
          if (chat._sdkHistoryHydrating) return;
          void syncSdkHistoryOnResume(chat, { reason: 'delegation_retry' }).catch(() => {});
          return;
        }
        alert(res?.error || t('chat.delegationRetryFailed'));
      }).catch(() => {
        alert(t('chat.serverConnectionError'));
      });
    },
    onRetryMailbox: (messageId) => {
      if (!chat?.id || !messageId) return;
      void api.postChatMailboxRetry(chat.id, messageId).then((res) => {
        if (res?.ok) return;
        alert(res?.error || t('chat.mailboxRetryFailed'));
      }).catch(() => {
        alert(t('chat.serverConnectionError'));
      });
    },
  };
}
