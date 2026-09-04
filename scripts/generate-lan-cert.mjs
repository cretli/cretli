#!/usr/bin/env node
/**
 * Generates a self-signed HTTPS certificate for LAN use (data/key.pem + data/cert.pem).
 * Relies on the system openssl binary.
 *
 * Usage:
 *   node scripts/generate-lan-cert.mjs                  # prompts for IP
 *   node scripts/generate-lan-cert.mjs 192.168.1.10     # IP from argument
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { resolveDataPath } from '../lib/runtime-paths.js';

const DATA = resolveDataPath();
const KEY_PATH = path.join(DATA, 'key.pem');
const CERT_PATH = path.join(DATA, 'cert.pem');

function hasOpenSsl() {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * There is no pure-Node fallback on purpose: Node cannot issue X.509 certificates
 * without an extra library, so openssl stays a hard requirement instead of a new dependency.
 */
function generateWithOpenssl(host) {
  const subj = `/CN=${host}`;
  const sanParts = ['DNS:localhost', 'IP:127.0.0.1'];
  if (host !== 'localhost' && host !== '127.0.0.1') {
    sanParts.push(`IP:${host}`);
  }
  const alt = `subjectAltName=${sanParts.join(',')}`;
  const cmd =
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${KEY_PATH}" ` +
    `-out "${CERT_PATH}" -days 825 -subj "${subj}" ` +
    `-addext "${alt}"`;
  execSync(cmd, { stdio: 'inherit' });
}

function main() {
  const argIp = process.argv[2]?.trim();
  let host = argIp;
  if (!host) {
    process.stdout.write('LAN IP of this server (e.g. 192.168.1.10): ');
    let line = '';
    try {
      line = readFileSync(0, 'utf8');
    } catch {
      console.error('\nNo TTY — pass the IP as an argument: node scripts/generate-lan-cert.mjs 192.168.1.10');
      process.exit(1);
    }
    host = line.trim();
  }
  if (!host) {
    console.error('Empty host — aborting.');
    process.exit(1);
  }

  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) {
    console.log(`[gen-cert] exists: ${path.relative(process.cwd(), KEY_PATH)} — overwriting.`);
  }

  if (!hasOpenSsl()) {
    console.error('[gen-cert] openssl is not available on this system — install it and try again.');
    process.exit(1);
  }

  generateWithOpenssl(host);
  console.log(`[gen-cert] OK`);
  console.log(`  key:  ${path.relative(process.cwd(), KEY_PATH)}`);
  console.log(`  cert: ${path.relative(process.cwd(), CERT_PATH)}`);
  console.log(`  host: ${host} (SAN: IP:${host}, DNS:localhost)`);
  console.log('');
  console.log('Start the server:');
  console.log('  npm run start:lan');
  console.log('On your phone open https://' + host + ':3011 and accept the certificate (Advanced → Proceed).');
}

main();
