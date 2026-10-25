import { configurationState } from '../../../state/index.js';
/**
 * Codex (API key, auth mode, ChatGPT login) controls of the connection settings tab.
 */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { applyCodexChatGptHint, applyCodexAuthModeSelect, renderCodexLoginBox, applyCodexApiKeyHint } from './lanSnapshotHints.js';

export function initCodexSettings() {
  const codexApiKeyInput = document.getElementById('codex-api-key-input');
  const codexApiKeySaveBtn = document.getElementById('codex-api-key-save-btn');
  const codexApiKeyClearBtn = document.getElementById('codex-api-key-clear-btn');
  const codexApiKeyStatusEl = document.getElementById('codex-api-key-save-status');

  if (codexApiKeySaveBtn && codexApiKeyInput) {
    codexApiKeySaveBtn.addEventListener('click', () => {
      const v = (codexApiKeyInput.value || '').trim();
      if (!v) {
        if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ codexApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyCodexApiKeyHint(data);
          if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('codex');
        })
        .catch(() => {
          if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (codexApiKeyClearBtn) {
    codexApiKeyClearBtn.addEventListener('click', () => {
      if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearCodexApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyCodexApiKeyHint(data);
          if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = t('common.removed');
          configurationState.invalidateCredentials('codex');
        })
        .catch(() => {
          if (codexApiKeyStatusEl) codexApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const codexAuthModeSelect = document.getElementById('codex-auth-mode-select');
  const codexAuthModeStatusEl = document.getElementById('codex-auth-mode-save-status');
  if (codexAuthModeSelect) {
    codexAuthModeSelect.addEventListener('cr-change', (event) => {
      const value = event?.detail?.value === 'chatgpt' ? 'chatgpt' : 'api-key';
      if (codexAuthModeStatusEl) codexAuthModeStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ codexAuthMode: value })
        .then((data) => {
          if (!data?.ok) {
            if (codexAuthModeStatusEl) codexAuthModeStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyCodexAuthModeSelect(data);
          applyCodexChatGptHint(data);
          applyCodexApiKeyHint(data);
          if (codexAuthModeStatusEl) codexAuthModeStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('codex');
        })
        .catch(() => {
          if (codexAuthModeStatusEl) codexAuthModeStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  let codexLoginPollId = 0;
  const stopCodexLoginPoll = () => {
    if (codexLoginPollId) {
      window.clearInterval(codexLoginPollId);
      codexLoginPollId = 0;
    }
  };
  const applyCodexLoginState = (payload) => {
    const login = payload?.login || payload;
    renderCodexLoginBox(login);
    if (payload && typeof payload.codexChatGptAuthEffective === 'boolean') {
      applyCodexChatGptHint(payload);
    }
    const statusEl = document.getElementById('codex-chatgpt-login-status');
    const phase = typeof login?.phase === 'string' ? login.phase : '';
    if (statusEl) {
      if (phase === 'completed') statusEl.textContent = t('settings.harnessCodexChatGptSignedIn');
      else if (phase === 'error') statusEl.textContent = login?.error || t('lanSettings.error');
      else if (phase === 'waiting' || phase === 'starting') statusEl.textContent = t('common.saving');
      else statusEl.textContent = '';
    }
    if (phase === 'completed' || phase === 'error' || phase === 'cancelled') {
      stopCodexLoginPoll();
      if (phase === 'completed') {
        configurationState.invalidateCredentials('codex');
      }
    }
  };
  const startCodexLoginPoll = () => {
    stopCodexLoginPoll();
    codexLoginPollId = window.setInterval(() => {
      api.getCodexLoginStatus()
        .then((data) => applyCodexLoginState(data))
        .catch(() => {});
    }, 1500);
  };

  const codexLoginBtn = document.getElementById('codex-chatgpt-login-btn');
  const codexLogoutBtn = document.getElementById('codex-chatgpt-logout-btn');
  if (codexLoginBtn) {
    codexLoginBtn.addEventListener('click', () => {
      const statusEl = document.getElementById('codex-chatgpt-login-status');
      if (statusEl) statusEl.textContent = t('common.saving');
      api
        .patchSettings({ codexAuthMode: 'chatgpt' })
        .then((data) => {
          if (!data?.ok) {
            if (statusEl) statusEl.textContent = data?.error || t('lanSettings.saveError');
            return null;
          }
          applyCodexAuthModeSelect(data);
          return api.startCodexLogin();
        })
        .then((data) => {
          if (!data) return;
          if (!data?.ok) {
            if (statusEl) statusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyCodexLoginState(data);
          startCodexLoginPoll();
        })
        .catch(() => {
          if (statusEl) statusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }
  if (codexLogoutBtn) {
    codexLogoutBtn.addEventListener('click', () => {
      stopCodexLoginPoll();
      const statusEl = document.getElementById('codex-chatgpt-login-status');
      if (statusEl) statusEl.textContent = t('common.removing');
      api
        .logoutCodex()
        .then((data) => {
          renderCodexLoginBox({ phase: 'idle' });
          applyCodexChatGptHint(data);
          if (statusEl) statusEl.textContent = t('common.removed');
          configurationState.invalidateCredentials('codex');
        })
        .catch(() => {
          if (statusEl) statusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  configurationState.onModelsChanged('codex', () => {
    api.getCodexStatus()
      .then((status) => {
        if (status?.ok) applyCodexChatGptHint(status);
      })
      .catch(() => {});
  });

  api.getCodexStatus()
    .then((status) => {
      if (!status?.login) return;
      applyCodexLoginState(status);
      if (status.login.phase === 'waiting' || status.login.phase === 'starting') {
        startCodexLoginPoll();
      }
    })
    .catch(() => {});
}
