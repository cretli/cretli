import { createHash, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { readTlsMaterials } from '../server-tls.js';

function publicChain(pem) {
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  return certs.map((cert) => new X509Certificate(cert).toString()).join('\n');
}

/** Public metadata only; never return the configured private key. */
export function describeCertificate(pem, now = Date.now()) {
  const cert = new X509Certificate(pem);
  const from = Date.parse(cert.validFrom);
  const until = Date.parse(cert.validTo);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    subjectAltName: cert.subjectAltName || '',
    fingerprint: cert.fingerprint256,
    revision: createHash('sha256').update(publicChain(pem)).digest('hex'),
    validFrom: new Date(from).toISOString(),
    validTo: new Date(until).toISOString(),
    status: now < from ? 'notYetValid' : now >= until ? 'expired' : until - now < 30 * 86400000 ? 'expiring' : 'valid',
    selfSigned: cert.checkIssued(cert) && cert.verify(cert.publicKey),
  };
}

/** Register after session authentication and widget restrictions. */
export function registerTlsSettingsRoutes(app, { server, certificate, keyPath, certPath }) {
  let activeCertificate = certificate;
  const enabled = !!certificate;
  app.use('/api/settings/tls', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.mcpIntegration || req.widgetAccess) return res.status(403).json({ ok: false, error: 'sessionRequired' });
    next();
  });
  function snapshot() {
    if (!enabled) return { ok: true, enabled: false };
    const active = describeCertificate(activeCertificate);
    let pending = null;
    let fileError = false;
    try {
      const material = readTlsMaterials(keyPath, certPath);
      createSecureContext(material);
      const disk = describeCertificate(material.cert);
      if (disk.revision !== active.revision) pending = disk;
    } catch {
      fileError = true;
    }
    return { ok: true, enabled: true, active, pending, fileError };
  }
  app.get('/api/settings/tls', (_req, res) => res.json(snapshot()));
  app.get('/api/settings/tls/certificate', (_req, res) => {
    if (!enabled) return res.status(409).json({ ok: false, error: 'httpsDisabled' });
    // Re-encode each certificate so unexpected PEM blocks can never be downloaded.
    const pem = publicChain(activeCertificate);
    res.type('application/x-pem-file').attachment('cretli-certificate-chain.pem').send(pem);
  });
  app.post('/api/settings/tls/reload', (req, res) => {
    if (!enabled) return res.status(409).json({ ok: false, error: 'httpsDisabled' });
    try {
      const material = readTlsMaterials(keyPath, certPath);
      const next = describeCertificate(material.cert);
      if (req.body?.revision !== next.revision) {
        return res.status(409).json({ ok: false, error: 'certificateChanged' });
      }
      if (next.status === 'expired' || next.status === 'notYetValid') {
        return res.status(400).json({ ok: false, error: 'certificateInvalid' });
      }
      // Validate the pair before mutating the live server. Existing sockets stay open.
      createSecureContext(material);
      server.setSecureContext({ ...material, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' });
      activeCertificate = material.cert;
      return res.json(snapshot());
    } catch {
      return res.status(400).json({ ok: false, error: 'certificateFilesInvalid' });
    }
  });
}
