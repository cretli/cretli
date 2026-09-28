import { createSdkRichView } from '../../app_front/lib/sdk-rich-view.js';
import * as api from '../../app_front/api.js';
import { applyCsrfFromAuthPayload } from '../../app_front/lib/cretliApiRequest.js';
import { initI18n, t } from '../../app_front/i18n/index.js';

const calls = [];
const alerts = [];
window.alert = (message) => {
  alerts.push(String(message || ''));
};

window.__delegationCard = {
  ready: false,
  calls,
  alerts,
  replay: () => {},
  append: () => {},
};

async function boot() {
  try {
    localStorage.setItem('cretli-lang', 'en');
  } catch {
    // ignore
  }
  await initI18n();
  const auth = await fetch('/api/auth-status').then((res) => res.json()).catch(() => ({}));
  applyCsrfFromAuthPayload(auth);
  const mount = document.getElementById('mount');
  const view = createSdkRichView({ id: 'parent-chat', sdkUiMode: 'full' }, mount, {
    appendPlain() {},
    onCancelDelegation(id) {
      calls.push({ type: 'cancel', id });
      return api.postDelegationCancel(id);
    },
    onAcknowledgeDelegation(id) {
      calls.push({ type: 'ack', id });
      return api.postDelegationAck(id, { reason: 'reviewed' });
    },
    onRetryDelegation(id) {
      calls.push({ type: 'retry', id });
      return api.postDelegationRetry(id).then((res) => {
        if (!res?.ok) alert(res?.error || t('chat.delegationRetryFailed'));
        return res;
      }).catch(() => {
        alert(t('chat.serverConnectionError'));
      });
    },
    onRetryMailbox(id) {
      calls.push({ type: 'mailbox-retry', id });
      return api.postChatMailboxRetry('parent-chat', id).then((res) => {
        if (!res?.ok) alert(res?.error || t('chat.mailboxRetryFailed'));
        return res;
      }).catch(() => {
        alert(t('chat.serverConnectionError'));
      });
    },
    onOpenDelegationChat(id) {
      calls.push({ type: 'open', id });
    },
  });
  window.__delegationCard.replay = (records) => view.replayHistoryRecords(records, { instant: true });
  window.__delegationCard.append = (records) => view.appendHistoryRecords(records, { instant: true });
  window.__delegationCard.ready = true;
}

void boot();
