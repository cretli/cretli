import { configurationState } from '../../../state/index.js';
/**
 * Cursor API key and Claude (API key, cache, plan login, auth mode) controls of the connection settings tab.
 */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { applyCursorApiKeyHint, applyClaudeAuthModeSelect, applyClaudeApiKeyHint, applyClaudeCacheSettings, renderClaudePlanLogin } from './lanSnapshotHints.js';

export function initCursorClaudeSettings() {
  const cursorApiKeyInput = document.getElementById('cursor-api-key-input');
  const cursorApiKeySaveBtn = document.getElementById('cursor-api-key-save-btn');
  const cursorApiKeyClearBtn = document.getElementById('cursor-api-key-clear-btn');
  const cursorApiKeyStatusEl = document.getElementById('cursor-api-key-save-status');

  if (cursorApiKeySaveBtn && cursorApiKeyInput) {
    cursorApiKeySaveBtn.addEventListener('click', () => {
      const v = (cursorApiKeyInput.value || '').trim();
      if (!v) {
        if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ cursorApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyCursorApiKeyHint(data);
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.saved');
        })
        .catch(() => {
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (cursorApiKeyClearBtn) {
    cursorApiKeyClearBtn.addEventListener('click', () => {
      if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearCursorApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyCursorApiKeyHint(data);
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.removed');
        })
        .catch(() => {
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const claudeApiKeyInput = document.getElementById('claude-api-key-input');
  const claudeApiKeySaveBtn = document.getElementById('claude-api-key-save-btn');
  const claudeApiKeyClearBtn = document.getElementById('claude-api-key-clear-btn');
  const claudeApiKeyStatusEl = document.getElementById('claude-api-key-save-status');

  if (claudeApiKeySaveBtn && claudeApiKeyInput) {
    claudeApiKeySaveBtn.addEventListener('click', () => {
      const v = (claudeApiKeyInput.value || '').trim();
      if (!v) {
        if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ claudeApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyClaudeAuthModeSelect(data);
          applyClaudeApiKeyHint(data);
          if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('claude');
        })
        .catch(() => {
          if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (claudeApiKeyClearBtn) {
    claudeApiKeyClearBtn.addEventListener('click', () => {
      if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearClaudeApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyClaudeAuthModeSelect(data);
          applyClaudeApiKeyHint(data);
          if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = t('common.removed');
          configurationState.invalidateCredentials('claude');
        })
        .catch(() => {
          if (claudeApiKeyStatusEl) claudeApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const claudeCacheSaveBtn = document.getElementById('claude-cache-save-btn');
  if (claudeCacheSaveBtn) {
    claudeCacheSaveBtn.addEventListener('click', () => {
      const cachingCheckbox = document.getElementById('claude-prompt-caching-1h-checkbox');
      const disableCompactCheckbox = document.getElementById('claude-disable-auto-compact-checkbox');
      const pctInput = document.getElementById('claude-autocompact-pct-input');
      const statusEl = document.getElementById('claude-cache-save-status');
      const rawPct = (pctInput?.value || '').trim();
      const payload = {
        claudePromptCaching1h: cachingCheckbox?.checked === true,
        claudeDisableAutoCompact: disableCompactCheckbox?.checked === true,
        claudeAutocompactPctOverride: rawPct ? rawPct : null,
      };
      if (statusEl) statusEl.textContent = t('common.saving');
      api
        .patchSettings(payload)
        .then((data) => {
          if (!data?.ok) {
            if (statusEl) statusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyClaudeCacheSettings(data);
          if (statusEl) statusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('claude');
        })
        .catch(() => {
          if (statusEl) statusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  function renderClaudePlanLogin(login) {
    const box = document.getElementById('claude-plan-login-box');
    const urlEl = document.getElementById('claude-plan-login-url');
    const waiting = login?.phase === 'waiting' && typeof login.url === 'string' && login.url;
    if (box) box.hidden = !waiting;
    if (urlEl instanceof HTMLAnchorElement) {
      urlEl.href = waiting ? login.url : '#';
      urlEl.textContent = waiting ? login.url : '';
    }
  }

  const claudePlanLoginBtn = document.getElementById('claude-plan-login-btn');
  const claudePlanLoginCancelBtn = document.getElementById('claude-plan-login-cancel-btn');
  const claudePlanLoginSubmitBtn = document.getElementById('claude-plan-login-submit-btn');
  const claudePlanLoginCode = document.getElementById('claude-plan-login-code');
  const claudePlanLoginStatusEl = document.getElementById('claude-plan-login-status');
  if (claudePlanLoginBtn) {
    claudePlanLoginBtn.addEventListener('click', () => {
      if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = t('common.saving');
      api.patchSettings({ claudeAuthMode: 'subscription' })
        .then((data) => {
          if (!data?.ok) {
            if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return null;
          }
          applyClaudeAuthModeSelect(data);
          return api.startClaudePlanLogin();
        })
        .then((data) => {
          if (!data) return;
          if (!data.ok) {
            if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = data.error || t('lanSettings.error');
            return;
          }
          renderClaudePlanLogin(data.login);
          if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = '';
        })
        .catch(() => {
          if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }
  if (claudePlanLoginCancelBtn) {
    claudePlanLoginCancelBtn.addEventListener('click', () => {
      api.cancelClaudePlanLogin()
        .then((data) => {
          renderClaudePlanLogin(data?.login);
          if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = '';
        })
        .catch(() => {
          if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }
  if (claudePlanLoginSubmitBtn) {
    claudePlanLoginSubmitBtn.addEventListener('click', () => {
      const code = claudePlanLoginCode && 'value' in claudePlanLoginCode
        ? String(claudePlanLoginCode.value || '').trim()
        : '';
      if (!code) {
        if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = t('settings.harnessClaudePlanCodeLabel');
        return;
      }
      if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = t('common.saving');
      api.completeClaudePlanLogin(code)
        .then((data) => {
          if (!data?.ok) {
            if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          renderClaudePlanLogin({ phase: 'idle' });
          if (claudePlanLoginCode && 'value' in claudePlanLoginCode) claudePlanLoginCode.value = '';
          if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('claude');
          api.getSettings().then((settings) => {
            if (settings?.ok) applyClaudeAuthModeSelect(settings);
          }).catch(() => {});
        })
        .catch(() => {
          if (claudePlanLoginStatusEl) claudePlanLoginStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const claudeAuthModeSelect = document.getElementById('claude-auth-mode-select');
  const claudeAuthModeStatusEl = document.getElementById('claude-auth-mode-save-status');
  if (claudeAuthModeSelect) {
    claudeAuthModeSelect.addEventListener('cr-change', (event) => {
      const value = event?.detail?.value === 'api-key' ? 'api-key' : 'subscription';
      if (claudeAuthModeStatusEl) claudeAuthModeStatusEl.textContent = t('common.saving');
      api.patchSettings({ claudeAuthMode: value })
        .then((data) => {
          if (!data?.ok) {
            if (claudeAuthModeStatusEl) claudeAuthModeStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyClaudeAuthModeSelect(data);
          applyClaudeApiKeyHint(data);
          if (claudeAuthModeStatusEl) claudeAuthModeStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('claude');
        })
        .catch(() => {
          if (claudeAuthModeStatusEl) claudeAuthModeStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }
}
