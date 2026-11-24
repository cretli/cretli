import { t } from '../../i18n/index.js';

export function createSendBarPromptSuggestion(options) {
  const { host, input, focusInput, onLayoutChange = () => {} } = options;
  let suggestion = '';
  const render = () => {
    host.replaceChildren();
    host.hidden = !suggestion || !!input.value;
    if (!host.hidden) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'send-keys-todo-chip-open';
      button.setAttribute('aria-label', t('sendBar.promptSuggestionInsert'));
      button.textContent = suggestion;
      button.addEventListener('click', () => {
        if (input.value) return;
        input.value = suggestion;
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        focusInput();
        suggestion = '';
        render();
      });
      host.appendChild(button);
    }
    onLayoutChange();
  };
  input.addEventListener('input', render);
  return {
    set(value) { suggestion = typeof value?.text === 'string' ? value.text.slice(0, 500) : ''; render(); },
    clear() { suggestion = ''; render(); },
  };
}
