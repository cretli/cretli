/**
 * Settings-snapshot appliers for the API-key / auth-mode blocks of the connection settings tab.
 */
import { t } from '../../../i18n/index.js';

export function applyCursorApiKeyHint(data) {
  const hint = document.getElementById('cursor-api-key-source-hint');
  const keyInput = document.getElementById('cursor-api-key-input');
  const keyStatus = document.getElementById('cursor-api-key-save-status');
  if (keyInput) keyInput.value = '';
  if (keyStatus) keyStatus.textContent = '';
  if (!hint) return;
  if (!data?.ok) {
    hint.textContent = '';
    return;
  }
  if (data.cursorApiKeyFromEnv) {
    hint.textContent = t('lanSettings.cursorKeyFromEnv');
    return;
  }
  if (data.cursorApiKeyStoredInSettings && data.cursorApiKeyEffective) {
    hint.textContent = t('lanSettings.cursorKeyStored');
    return;
  }
  hint.textContent = t('lanSettings.cursorKeyMissing');
}

export function applyClaudeAuthModeSelect(data) {
  const selectEl = document.getElementById('claude-auth-mode-select');
  const statusEl = document.getElementById('claude-subscription-status');
  if (selectEl && selectEl.tagName === 'CR-BAR-SELECT') {
    selectEl.options = [
      { value: 'subscription', label: t('settings.harnessClaudeAuthModeSubscription') },
      { value: 'api-key', label: t('settings.harnessClaudeAuthModeApiKey') },
    ];
    selectEl.value = data?.claudeAuthMode === 'api-key' ? 'api-key' : 'subscription';
  }
  if (!statusEl) return;
  if (!data?.ok || data.claudeAuthMode === 'api-key') {
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = data.claudeSubscriptionSignedIn
    ? t('settings.harnessClaudeSubscriptionSignedIn')
    : t('settings.harnessClaudeSubscriptionMissing');
}

export function applyClaudeApiKeyHint(data) {
  const hint = document.getElementById('claude-api-key-source-hint');
  const keyInput = document.getElementById('claude-api-key-input');
  const keyStatus = document.getElementById('claude-api-key-save-status');
  if (keyInput) keyInput.value = '';
  if (keyStatus) keyStatus.textContent = '';
  if (!hint) return;
  if (!data?.ok) {
    hint.textContent = '';
    return;
  }
  if (data.claudeProviderConfigured) {
    hint.textContent = t('lanSettings.claudeProviderConfigured');
    return;
  }
  if (data.claudeApiKeyFromEnv) {
    hint.textContent = t('lanSettings.claudeKeyFromEnv');
    return;
  }
  if (data.claudeApiKeyStoredInSettings && data.claudeApiKeyEffective) {
    hint.textContent = t('lanSettings.claudeKeyStored');
    return;
  }
  hint.textContent = t('lanSettings.claudeKeyMissing');
}

export function applyClaudeCacheSettings(data) {
  const cachingCheckbox = document.getElementById('claude-prompt-caching-1h-checkbox');
  const disableCompactCheckbox = document.getElementById('claude-disable-auto-compact-checkbox');
  const pctInput = document.getElementById('claude-autocompact-pct-input');
  const statusEl = document.getElementById('claude-cache-save-status');
  if (cachingCheckbox) cachingCheckbox.checked = data?.claudePromptCaching1h === true;
  if (disableCompactCheckbox) disableCompactCheckbox.checked = data?.claudeDisableAutoCompact === true;
  if (pctInput) {
    const pct = Number(data?.claudeAutocompactPctOverride);
    pctInput.value = Number.isFinite(pct) && pct > 0 ? String(pct) : '';
  }
  if (statusEl) statusEl.textContent = '';
}

export function applyCodexChatGptHint(data) {
  const statusEl = document.getElementById('codex-chatgpt-status');
  if (!statusEl) return;
  if (!data?.codexChatGptAuthEffective) {
    statusEl.textContent = t('lanSettings.codexChatGptSignedOut');
    return;
  }
  const plan = String(data.chatgptPlanType || '').trim();
  if (!plan) {
    statusEl.textContent = t('lanSettings.codexChatGptSignedIn');
    return;
  }
  statusEl.textContent = `${t('lanSettings.codexChatGptSignedIn')} ${t('settings.harnessCodexChatGptPlanType', { plan })}`;
}

export function applyCodexAuthModeSelect(data) {
  const selectEl = document.getElementById('codex-auth-mode-select');
  if (!selectEl || selectEl.tagName !== 'CR-BAR-SELECT') return;
  selectEl.options = [
    { value: 'chatgpt', label: t('settings.harnessCodexAuthModeChatGpt') },
    { value: 'api-key', label: t('settings.harnessCodexAuthModeApiKey') },
  ];
  selectEl.value = data?.codexAuthMode === 'chatgpt' ? 'chatgpt' : 'api-key';
}

export function renderCodexLoginBox(login) {
  const box = document.getElementById('codex-chatgpt-login-box');
  const urlEl = document.getElementById('codex-chatgpt-login-url');
  const codeEl = document.getElementById('codex-chatgpt-login-code');
  if (!box) return;
  const url = typeof login?.url === 'string' ? login.url.trim() : '';
  const code = typeof login?.userCode === 'string' ? login.userCode.trim() : '';
  const waiting = login?.phase === 'waiting' || login?.phase === 'starting';
  box.hidden = !waiting || (!url && !code);
  if (urlEl instanceof HTMLAnchorElement) {
    urlEl.href = url || '#';
    urlEl.textContent = url;
  }
  if (codeEl) codeEl.textContent = code;
}

export function applyCodexApiKeyHint(data) {
  const hint = document.getElementById('codex-api-key-source-hint');
  const keyInput = document.getElementById('codex-api-key-input');
  const keyStatus = document.getElementById('codex-api-key-save-status');
  if (keyInput) keyInput.value = '';
  if (keyStatus) keyStatus.textContent = '';
  if (!hint) return;
  if (!data?.ok) {
    hint.textContent = '';
    return;
  }
  if (data.codexApiKeyFromEnv) {
    hint.textContent = t('lanSettings.codexKeyFromEnv');
    return;
  }
  if (data.codexApiKeyStoredInSettings && data.codexApiKeyEffective) {
    hint.textContent = t('lanSettings.codexKeyStored');
    return;
  }
  hint.textContent = t('lanSettings.codexKeyMissing');
}

export function applyOpenAiApiKeyHint(data) {
  const hint = document.getElementById('openai-api-key-source-hint');
  const keyInput = document.getElementById('openai-api-key-input');
  const keyStatus = document.getElementById('openai-api-key-save-status');
  if (keyInput) keyInput.value = '';
  if (keyStatus) keyStatus.textContent = '';
  if (!hint) return;
  if (!data?.ok) {
    hint.textContent = '';
    return;
  }
  if (data.openaiApiKeyFromEnv) {
    hint.textContent = t('lanSettings.openaiKeyFromEnv');
    return;
  }
  if (data.openaiApiKeyInvalidFormat) {
    hint.textContent = t('lanSettings.openaiKeyInvalidFormat');
    return;
  }
  if (data.openaiApiKeyStoredInSettings && data.openaiApiKeyEffective) {
    hint.textContent = t('lanSettings.openaiKeyStored');
    return;
  }
  hint.textContent = t('lanSettings.openaiKeyMissing');
}

export function applyAzureSpeechHint(data) {
  const hint = document.getElementById('azure-speech-source-hint');
  const keyInput = document.getElementById('azure-speech-key-input');
  const regionInput = document.getElementById('azure-speech-region-input');
  const keyStatus = document.getElementById('azure-speech-save-status');
  if (keyInput) keyInput.value = '';
  if (keyStatus) keyStatus.textContent = '';
  if (!hint) return;
  if (!data?.ok) {
    hint.textContent = '';
    return;
  }
  // The region is not a secret, so showing it back confirms which account is used.
  if (regionInput) regionInput.value = data.azureSpeechRegion || '';
  if (data.azureSpeechFromEnv) {
    hint.textContent = t('lanSettings.azureSpeechFromEnv');
    return;
  }
  if (data.azureSpeechInvalidFormat) {
    hint.textContent = t('lanSettings.azureSpeechInvalid');
    return;
  }
  if (data.azureSpeechStoredInSettings && data.azureSpeechEffective) {
    hint.textContent = t('lanSettings.azureSpeechStored');
    return;
  }
  hint.textContent = t('lanSettings.azureSpeechMissing');
}

export function applyGeminiApiKeyHint(data) {
  const hint = document.getElementById('gemini-api-key-source-hint');
  const keyInput = document.getElementById('gemini-api-key-input');
  const keyStatus = document.getElementById('gemini-api-key-save-status');
  if (keyInput) keyInput.value = '';
  if (keyStatus) keyStatus.textContent = '';
  if (!hint) return;
  if (!data?.ok) {
    hint.textContent = '';
    return;
  }
  if (data.geminiApiKeyFromEnv) {
    hint.textContent = t('lanSettings.geminiKeyFromEnv');
    return;
  }
  if (data.geminiApiKeyInvalidFormat) {
    hint.textContent = t('lanSettings.geminiKeyInvalid');
    return;
  }
  if (data.geminiApiKeyStoredInSettings && data.geminiApiKeyEffective) {
    hint.textContent = t('lanSettings.geminiKeyStored');
    return;
  }
  hint.textContent = t('lanSettings.geminiKeyMissing');
}

export function renderClaudePlanLogin(login) {
  const box = document.getElementById('claude-plan-login-box');
  const urlEl = document.getElementById('claude-plan-login-url');
  const waiting = login?.phase === 'waiting' && typeof login.url === 'string' && login.url;
  if (box) box.hidden = !waiting;
  if (urlEl instanceof HTMLAnchorElement) {
    urlEl.href = waiting ? login.url : '#';
    urlEl.textContent = waiting ? login.url : '';
  }
}
