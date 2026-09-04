/**
 * Termux/Android network shims for the musl Codex CLI.
 * Android has no /etc/resolv.conf or /etc/ssl CA store; the static binary
 * then fails device-code login with "error sending request for url".
 */

import fs from 'fs';
import path from 'path';
import { ensureCodexHomeDir } from './codex-home.js';

const LAUNCHER_NAME = 'codex-termux.sh';
const FALLBACK_RESOLV = 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n';

/**
 * @param {string} [platform]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isTermuxLike(platform = process.platform, env = process.env) {
  if (platform === 'android') return true;
  const prefix = typeof env?.PREFIX === 'string' ? env.PREFIX : '';
  if (prefix.includes('com.termux')) return true;
  if (typeof env?.TERMUX_VERSION === 'string' && env.TERMUX_VERSION.trim()) return true;
  return false;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isCodexDeviceAuthRequestError(text) {
  const raw = String(text || '');
  if (!/error sending request for url/i.test(raw)) return false;
  return /auth\.openai\.com|deviceauth/i.test(raw);
}

/**
 * @returns {string}
 */
export function getCodexTermuxRequestErrorHint() {
  return 'Codex cannot reach auth.openai.com from Termux (no /etc/resolv.conf or CA store). Install: pkg install proot ca-certificates — then restart Cretli.';
}

/**
 * @param {{ PREFIX?: string, existsFn?: (p: string) => boolean }} [options]
 * @returns {string}
 */
export function resolveTermuxCaBundle(options = {}) {
  const prefix = typeof options.PREFIX === 'string' && options.PREFIX.trim()
    ? options.PREFIX.trim()
    : String(process.env.PREFIX || '').trim();
  const exists = typeof options.existsFn === 'function' ? options.existsFn : (p) => fs.existsSync(p);
  const candidates = [];
  if (prefix) {
    candidates.push(path.join(prefix, 'etc', 'tls', 'cert.pem'));
    candidates.push(path.join(prefix, 'etc', 'tls', 'certs', 'ca-certificates.crt'));
  }
  candidates.push('/data/data/com.termux/files/usr/etc/tls/cert.pem');
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return '';
}

/**
 * @param {Record<string, string>} env
 * @param {{ platform?: string, existsFn?: (p: string) => boolean }} [options]
 * @returns {Record<string, string>}
 */
export function applyCodexTermuxNetworkEnv(env, options = {}) {
  const platform = options.platform || process.platform;
  if (!isTermuxLike(platform, env)) return env;
  const ca = resolveTermuxCaBundle({
    PREFIX: env.PREFIX,
    existsFn: options.existsFn,
  });
  if (!ca) return env;
  if (!String(env.SSL_CERT_FILE || '').trim()) env.SSL_CERT_FILE = ca;
  if (!String(env.CODEX_CA_CERTIFICATE || '').trim()) env.CODEX_CA_CERTIFICATE = ca;
  return env;
}

/**
 * @param {{ proot: string, resolv: string, ca: string, bin: string }} input
 * @returns {string[]}
 */
export function buildCodexTermuxProotArgs(input) {
  return [
    input.proot,
    '-b', `${input.resolv}:/etc/resolv.conf`,
    '-b', `${input.ca}:/etc/ssl/certs/ca-certificates.crt`,
    input.bin,
  ];
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isFile(candidate) {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function resolveProotBin(env) {
  const prefix = typeof env.PREFIX === 'string' ? env.PREFIX.trim() : '';
  if (prefix) {
    const fromPrefix = path.join(prefix, 'bin', 'proot');
    if (isFile(fromPrefix)) return fromPrefix;
  }
  const pathEnv = env.PATH || process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'proot');
    if (isFile(candidate)) return candidate;
  }
  return '';
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function resolveResolvConf(env) {
  const prefix = typeof env.PREFIX === 'string' ? env.PREFIX.trim() : '';
  if (prefix) {
    const fromPrefix = path.join(prefix, 'etc', 'resolv.conf');
    if (isFile(fromPrefix)) return fromPrefix;
  }
  const fallback = path.join(ensureCodexHomeDir(), 'resolv.conf');
  if (!isFile(fallback)) {
    fs.writeFileSync(fallback, FALLBACK_RESOLV, 'utf8');
  }
  return fallback;
}

/**
 * On Termux, wrap the native Codex binary with proot so musl sees DNS + CA files.
 *
 * @param {string} nativeBin
 * @returns {string}
 */
export function ensureCodexTermuxLauncher(nativeBin) {
  const bin = String(nativeBin || '').trim();
  if (!bin || path.basename(bin) === LAUNCHER_NAME) return bin;
  if (path.basename(bin) === 'codex.js') return bin;
  if (!isTermuxLike()) return bin;
  const env = process.env;
  const proot = resolveProotBin(env);
  const ca = resolveTermuxCaBundle({ PREFIX: env.PREFIX });
  if (!proot || !ca) return bin;
  const resolv = resolveResolvConf(env);
  const launcher = path.join(ensureCodexHomeDir(), LAUNCHER_NAME);
  const argv = buildCodexTermuxProotArgs({ proot, resolv, ca, bin });
  const quoted = argv.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
  const body = `#!/usr/bin/env sh\nexec ${quoted} "$@"\n`;
  fs.writeFileSync(launcher, body, { mode: 0o755 });
  return launcher;
}
