import path from 'node:path';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';

/**
 * @typedef {Object} ResolvedTlsConfig
 * @property {import('node:http').Server | import('node:https').Server} server
 * @property {boolean} useHttps
 */

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isHttpsRequested(value) {
  return value === '1' || value === 'true';
}

/**
 * True when env points at TLS files other than the default data/key.pem + data/cert.pem.
 * @param {string} keyPath
 * @param {string} certPath
 * @param {string} defaultKeyPath
 * @param {string} defaultCertPath
 * @returns {boolean}
 */
export function usesCustomTlsPaths(keyPath, certPath, defaultKeyPath, defaultCertPath) {
  const key = String(keyPath || '').trim();
  const cert = String(certPath || '').trim();
  if (!key || !cert) return false;
  return path.resolve(key) !== path.resolve(defaultKeyPath)
    || path.resolve(cert) !== path.resolve(defaultCertPath);
}

/**
 * Default data/ certs are generated only for HTTPS with the default paths.
 * Custom SSL_KEY_PATH / SSL_CERT_PATH must already exist — they are not replaced.
 * @param {{
 *   useHttpsEnv?: string,
 *   keyPath?: string,
 *   certPath?: string,
 *   defaultKeyPath: string,
 *   defaultCertPath: string,
 * }} options
 * @returns {boolean}
 */
export function shouldGenerateDefaultTlsCerts(options) {
  if (!isHttpsRequested(options.useHttpsEnv ?? '')) return false;
  if (usesCustomTlsPaths(
    options.keyPath,
    options.certPath,
    options.defaultKeyPath,
    options.defaultCertPath,
  )) {
    return false;
  }
  return true;
}

/**
 * @param {string} keyPath
 * @param {string} certPath
 * @param {(path: string, encoding: 'utf8') => string} readFile
 * @returns {{ key: string, cert: string }}
 */
export function readTlsMaterials(keyPath, certPath, readFile = readFileSync) {
  if (!existsSync(keyPath)) {
    throw new Error(`TLS key not found at ${keyPath}. Run: node scripts/generate-ssl-cert.js`);
  }
  if (!existsSync(certPath)) {
    throw new Error(`TLS certificate not found at ${certPath}. Run: node scripts/generate-ssl-cert.js`);
  }
  let key = '';
  let cert = '';
  try {
    key = readFile(keyPath, 'utf8');
    cert = readFile(certPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read TLS key/cert (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!String(key).includes('BEGIN') || !String(cert).includes('BEGIN')) {
    throw new Error('TLS key or certificate is not valid PEM. Regenerate with: node scripts/generate-ssl-cert.js');
  }
  return { key, cert };
}

/**
 * @param {import('express').Express} app
 * @param {{ useHttpsEnv?: string, keyPath: string, certPath: string, readFile?: (path: string, encoding: 'utf8') => string }} options
 * @returns {ResolvedTlsConfig}
 */
export function resolveServerTransport(app, options) {
  const useHttpsEnv = options.useHttpsEnv ?? process.env.USE_HTTPS ?? '';
  if (!isHttpsRequested(useHttpsEnv)) {
    return { server: createServer(app), useHttps: false };
  }
  const { key, cert } = readTlsMaterials(
    options.keyPath,
    options.certPath,
    options.readFile,
  );
  const server = createHttpsServer({
    key,
    cert,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
  }, app);
  return { server, useHttps: true };
}

/**
 * @param {Error} err
 * @returns {never}
 */
export function exitOnTlsFailure(err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Cretli: HTTPS is enabled but TLS setup failed: ${message}`);
  console.error('Fix the certificate paths or set USE_HTTPS=0 for explicit HTTP.');
  process.exit(1);
}
