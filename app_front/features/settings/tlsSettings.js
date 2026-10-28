import { html, render, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import '../../components/ui/index.js';
import './tls-settings.scss';

let data;
let busy = false;
let message = '';
let tone = '';

function certificateDetails(cert) {
  return html`<dl class="tls-certificate-details">
    <dt>${t('settings.tlsSubject')}</dt><dd>${cert.subject}</dd>
    <dt>${t('settings.tlsIssuer')}</dt><dd>${cert.issuer}</dd>
    <dt>${t('settings.tlsNames')}</dt><dd>${cert.subjectAltName || '—'}</dd>
    <dt>${t('settings.tlsValidity')}</dt><dd>${new Date(cert.validFrom).toLocaleDateString()} – ${new Date(cert.validTo).toLocaleDateString()}</dd>
    <dt>SHA-256</dt><dd><code>${cert.fingerprint}</code></dd>
  </dl>`;
}

function paint() {
  document.querySelectorAll('.tls-settings-root').forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    render(html`
    <h3 class="settings-section-title">${t('settings.tlsTitle')}</h3>
    <div class="cr-row">
      <cr-bar-button ?disabled=${busy} @click=${refreshTlsSettings}>${t('settings.tlsRefresh')}</cr-bar-button>
      ${data?.enabled ? html`<cr-bar-button ?disabled=${busy} @click=${downloadCertificate}>${t('settings.tlsDownload')}</cr-bar-button>` : nothing}
    </div>
    <p class="cr-status" data-tone=${tone} role="status">${message}</p>
    ${data ? data.enabled ? html`
      <p class="cr-hint" data-tone=${data.active.status === 'valid' ? 'success' : 'error'}>
        ${t(`settings.tlsStatus_${data.active.status}`)} · ${t(data.active.selfSigned ? 'settings.tlsSelfSigned' : 'settings.tlsIssued')}
      </p>
      ${certificateDetails(data.active)}
      ${data.fileError ? html`<p class="cr-status" data-tone="error">${t('settings.tlsFileError')}</p>` : nothing}
      ${data.pending ? html`<div class="cr-card">
        <p class="cr-hint">${t('settings.tlsPending')}</p>
        ${certificateDetails(data.pending)}
        <cr-bar-button variant="primary" ?disabled=${busy || ['expired', 'notYetValid'].includes(data.pending.status)} @click=${reloadCertificate}>${t('settings.tlsApply')}</cr-bar-button>
      </div>` : nothing}
      <details class="tls-help">
        <summary>${t('settings.tlsTrustTitle')}</summary>
        <ol>
          <li>${t('settings.tlsTrustDownload')}</li>
          <li>${t('settings.tlsTrustCa')}</li>
          <li>${t('settings.tlsTrustNode')}<pre><code>NODE_EXTRA_CA_CERTS=/path/to/trusted-ca.pem</code></pre></li>
          <li>${t('settings.tlsTrustRestart')}</li>
        </ol>
        <p class="cr-hint">${t('settings.tlsBrowserTrust')}</p>
      </details>
      <p class="cr-hint">${t('settings.tlsReplaceHint')}</p>
    ` : html`<p class="cr-hint">${t('settings.tlsHttp')}</p>` : nothing}
    `, root);
  });
}

async function request(path, init) {
  const response = await cretliApiFetch(path, init);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'requestFailed');
  return result;
}

export async function refreshTlsSettings() {
  if (busy) return;
  busy = true;
  message = t('settings.tlsLoading');
  tone = '';
  paint();
  try {
    data = await request('/api/settings/tls');
    message = '';
  } catch {
    data = undefined;
    tone = 'error';
    message = t('settings.tlsLoadError');
  } finally {
    busy = false;
    paint();
  }
}

async function reloadCertificate() {
  if (busy || !data?.pending) return;
  busy = true;
  message = t('settings.tlsLoading');
  tone = '';
  paint();
  try {
    data = await request('/api/settings/tls/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: data.pending.revision }),
    });
    message = t('settings.tlsApplied');
    tone = 'success';
  } catch (error) {
    message = t(error.message === 'certificateChanged' ? 'settings.tlsChanged' : 'settings.tlsApplyError');
    tone = 'error';
  } finally {
    busy = false;
    paint();
  }
}

async function downloadCertificate() {
  if (busy) return;
  busy = true;
  paint();
  try {
    const response = await cretliApiFetch('/api/settings/tls/certificate');
    if (!response.ok) throw new Error('downloadFailed');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cretli-certificate-chain.pem';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    message = t('settings.tlsLoadError');
    tone = 'error';
  } finally {
    busy = false;
    paint();
  }
}
