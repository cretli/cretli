import { html, render, nothing } from 'lit';
import { autostartActivationMessage } from './autostartActivation.js';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import '../../components/ui/index.js';

let data, pending, busy = false, message = '';
function paint() {
  document.querySelectorAll('.autostart-settings-root').forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    render(html`
    <div class="cr-card">
      <h3 class="cr-section-title">${t('settings.autostartTitle')}</h3>
      <cr-bar-button ?disabled=${busy} @click=${refreshAutostartSettings}>${t('settings.autostartRefresh')}</cr-bar-button>
      ${data ? html`
        <p>${t(data.managedExternally
          ? data.externalEnabled === true ? 'settings.autostartSystemEnabled' : data.externalEnabled === false ? 'settings.autostartSystemDisabled' : 'settings.autostartSystemUnknown'
          : data.supported ? data.installed ? 'settings.autostartInstalled' : 'settings.autostartMissing' : 'settings.autostartUnsupported')}</p>
        ${data.managedExternally ? html`<p class="cr-hint">${t('settings.autostartSystemHint')}</p>` : nothing}
        ${data.foreign ? html`<p class="cr-hint">${t('settings.autostartForeignHint')}</p>` : nothing}
        ${data.supported && !data.managedExternally && !data.foreign ? html`
          <cr-checkbox .checked=${data.installed} ?disabled=${busy}
            @change=${(event) => { pending = !data.installed; event.target.checked = data.installed; paint(); }}>${t('settings.autostartEnable')}</cr-checkbox>
        ` : nothing}
      ` : nothing}
      <p class="cr-status" role="status">${message}</p>
      <cr-dialog .open=${pending !== undefined} .heading=${t('settings.autostartConfirmTitle')}
        @cr-dialog-close=${() => { pending = undefined; paint(); }}>
        <p>${t(pending ? 'settings.autostartConfirmEnable' : 'settings.autostartConfirmDisable')}</p>
        <cr-bar-button slot="actions" ?disabled=${busy} @click=${() => { pending = undefined; paint(); }}>${t('settings.autostartCancel')}</cr-bar-button>
        <cr-bar-button slot="actions" variant="primary" ?disabled=${busy} @click=${apply}>${t('settings.autostartConfirm')}</cr-bar-button>
      </cr-dialog>
    </div>`, root);
  });
}
async function request(init) {
  const response = await cretliApiFetch('/api/settings/autostart', init);
  if (!response.ok) throw new Error();
  return response.json();
}
export async function refreshAutostartSettings() {
  if (busy) return;
  busy = true; paint();
  try { data = await request(); message = ''; }
  catch { message = t('settings.autostartError'); }
  finally { busy = false; paint(); }
}
async function apply() {
  if (busy || pending === undefined) return;
  busy = true; paint();
  try {
    data = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: pending, confirm: true }) });
    message = autostartActivationMessage(data, t);
    pending = undefined;
  } catch { message = t('settings.autostartError'); }
  finally { busy = false; paint(); }
}
