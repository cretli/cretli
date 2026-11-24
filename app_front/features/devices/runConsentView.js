import { html } from 'lit';

export function renderRunConsentView(prompts, t, busyId, error, answer) {
  return html`${prompts.map((prompt) => html`
    <div class="prompt" role="group" data-device-run-consent>
      <p class="text">${t('chat.deviceRunConsentText', { path: prompt.scriptPath, hash: prompt.hash, device: prompt.deviceName })}</p>
      <p class="hint">${t('chat.deviceRunConsentUnsandboxed')}</p>
      <div class="actions">
        <cr-bar-button variant="primary" ?disabled=${busyId === prompt.id}
          @click=${() => answer(prompt, 'once')}>${t('chat.deviceRunConsentOnce')}</cr-bar-button>
        <cr-bar-button ?disabled=${busyId === prompt.id}
          @click=${() => answer(prompt, 'deny')}>${t('chat.deviceRunConsentDeny')}</cr-bar-button>
      </div>
      ${error ? html`<p class="error" data-tone="error">${t('chat.deviceRunConsentError')}</p>` : ''}
    </div>`)}`;
}
