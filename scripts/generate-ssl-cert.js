/**
 * Generates a self-signed certificate (key.pem, cert.pem) in data/.
 * Needed for HTTPS, e.g. dictation on a phone (the Web Speech API requires a secure context).
 * Run: node scripts/generate-ssl-cert.js
 * For LAN access, set env SSL_IP to the server address, then run this script.
 * Then: USE_HTTPS=1 npm start
 */

import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { resolveDataPath } from '../lib/runtime-paths.js';

const dataDir = resolveDataPath();
const keyPath = path.join(dataDir, 'key.pem');
const certPath = path.join(dataDir, 'cert.pem');

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// SAN (Subject Alternative Name) is required by Chrome for HTTPS over a bare IP
const lanIp = process.env.SSL_IP || '';
const san = ['DNS:localhost', 'IP:127.0.0.1'].concat(lanIp ? [`IP:${lanIp}`] : []).join(', ');
const configContent = `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = localhost
[v3_req]
subjectAltName = ${san}
`;

const keyExists = existsSync(keyPath);
const certExists = existsSync(certPath);
if (keyExists && certExists) {
  console.log('key.pem and cert.pem already exist in data/.');
  console.log('To regenerate them from scratch (e.g. with a different IP), delete them and run this script again.');
  console.log('Start the server with: USE_HTTPS=1 npm start');
  process.exit(0);
}

const configPath = path.join(dataDir, 'openssl-san.cnf');
writeFileSync(configPath, configContent, 'utf8');

const openssl = spawnSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '365',
    '-nodes',
    '-config', configPath,
  ],
  { stdio: 'inherit' }
);

try {
  unlinkSync(configPath);
} catch (_) {}

if (openssl.status !== 0) {
  console.error('Certificate generation failed. Install openssl (e.g. apt install openssl).');
  process.exit(1);
}

console.log('Generated data/key.pem and data/cert.pem (valid 365 days, SAN: localhost, 127.0.0.1' + (lanIp ? `, ${lanIp}` : '') + ').');
console.log('Start the server with: USE_HTTPS=1 npm start');
if (lanIp) {
  console.log('On your phone open https://' + lanIp + ':3011 and accept the certificate warning.');
} else {
  console.log('For LAN access by IP, set env SSL_IP to that address and run this script again (delete existing key.pem/cert.pem first).');
}
