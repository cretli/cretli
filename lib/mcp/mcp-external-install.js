/**
 * Writes the Cretli MCP client configuration into a project folder for
 * Claude Code, Codex or Cursor. Without a token each file references the
 * CRETLI_MCP_TOKEN environment variable (safe to commit); with a freshly
 * issued token the file carries it, so the tool works with no extra setup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTERNAL_MCP_INSTALL_TARGETS = Object.freeze(['claude', 'codex', 'cursor']);
export const EXTERNAL_MCP_TOKEN_ENV = 'CRETLI_MCP_TOKEN';
export const EXTERNAL_MCP_INSTALL_MODES = Object.freeze(['http', 'stdio']);
const SERVER_NAME = 'cretli';
/** Stdio bridge shipped with Cretli; the stdio mode points the client at this file. */
const BRIDGE_SCRIPT = fileURLToPath(new URL('../../scripts/cretli-mcp-http-bridge.mjs', import.meta.url));

export class ExternalMcpInstallError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.name = 'ExternalMcpInstallError';
    this.status = status;
  }
}

/** Relative config file per target. */
const TARGET_FILES = {
  claude: '.mcp.json',
  cursor: path.join('.cursor', 'mcp.json'),
  codex: path.join('.codex', 'config.toml'),
};

/** @param {unknown} value */
function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * @param {string} target
 * @param {string} url
 * @param {string} [token] Literal token; an environment reference when omitted.
 */
function jsonEntry(target, url, token, mode = 'http', caFile = '') {
  if (mode === 'stdio') {
    const ref = `\${${target === 'cursor' ? 'env:' : ''}${EXTERNAL_MCP_TOKEN_ENV}}`;
    return {
      command: 'node',
      args: [BRIDGE_SCRIPT],
      env: { CRETLI_MCP_URL: url, [EXTERNAL_MCP_TOKEN_ENV]: token || ref, ...(caFile ? { CRETLI_MCP_CA_FILE: caFile } : {}) },
    };
  }
  const bearer = token
    ? `Bearer ${token}`
    : `Bearer \${${target === 'cursor' ? 'env:' : ''}${EXTERNAL_MCP_TOKEN_ENV}}`;
  const headers = { Authorization: bearer };
  return target === 'cursor' ? { url, headers } : { type: 'http', url, headers };
}

/**
 * @param {string} url
 * @param {string} [token]
 */
function codexBlock(url, token, mode = 'http', caFile = '') {
  if (mode === 'stdio') {
    const env = `env = { CRETLI_MCP_URL = ${tomlString(url)}${token ? `, ${EXTERNAL_MCP_TOKEN_ENV} = ${tomlString(token)}` : ''}${caFile ? `, CRETLI_MCP_CA_FILE = ${tomlString(caFile)}` : ''} }`;
    const vars = token ? '' : `env_vars = [${tomlString(EXTERNAL_MCP_TOKEN_ENV)}]\n`;
    return `[mcp_servers.${SERVER_NAME}]\ncommand = "node"\nargs = [${tomlString(BRIDGE_SCRIPT)}]\n${env}\n${vars}`;
  }
  const auth = token
    ? `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`
    : `bearer_token_env_var = ${tomlString(EXTERNAL_MCP_TOKEN_ENV)}`;
  return `[mcp_servers.${SERVER_NAME}]\nurl = ${tomlString(url)}\n${auth}\n`;
}

/**
 * Replace (or append) the `[mcp_servers.cretli]` table, keeping the rest of the file.
 *
 * @param {string} existing
 * @param {string} url
 * @param {string} [token]
 * @param {string} [mode] `http` or `stdio`.
 */
export function mergeCodexToml(existing, url, token, mode = 'http', caFile = '') {
  const block = codexBlock(url, token, mode, caFile);
  const lines = existing.split('\n');
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const base = existing.trimEnd();
    return base ? `${base}\n\n${block}` : block;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // The next table that is not a sub-table of ours ends the block.
    if (/^\s*\[/.test(lines[i]) && !lines[i].trim().startsWith(`[mcp_servers.${SERVER_NAME}.`)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start).join('\n').trimEnd();
  const after = lines.slice(end).join('\n').trimStart();
  return [before, block.trimEnd(), after].filter(Boolean).join('\n\n') + '\n';
}

/**
 * @param {string} filePath
 */
function assertWritableFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ExternalMcpInstallError(`${path.basename(filePath)} is not a regular file; refusing to overwrite it`, 409);
  }
  return true;
}

/**
 * @param {{ target: unknown, folder: string, url: unknown, token?: string, mode?: string, caFile?: string }} input
 * @returns {{ target: string, file: string, relativeFile: string, existed: boolean, tokenEnv: string, tokenWritten: boolean, mode: string }}
 */
export function installExternalMcpConfig({ target, folder, url, token, mode = 'http', caFile = '' }) {
  const key = String(target || '');
  if (!EXTERNAL_MCP_INSTALL_TARGETS.includes(key)) {
    throw new ExternalMcpInstallError(`target must be one of: ${EXTERNAL_MCP_INSTALL_TARGETS.join(', ')}`);
  }
  if (!EXTERNAL_MCP_INSTALL_MODES.includes(String(mode))) {
    throw new ExternalMcpInstallError(`mode must be one of: ${EXTERNAL_MCP_INSTALL_MODES.join(', ')}`);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url || ''));
  } catch {
    throw new ExternalMcpInstallError('url must be an absolute http(s) URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ExternalMcpInstallError('url must be an absolute http(s) URL');
  }
  if (caFile && (mode !== 'stdio' || parsedUrl.protocol !== 'https:')) {
    throw new ExternalMcpInstallError('The CA file requires an HTTPS URL and stdio mode');
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(folder).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw new ExternalMcpInstallError('The target folder does not exist', 409);

  const relativeFile = TARGET_FILES[/** @type {keyof typeof TARGET_FILES} */ (key)];
  const file = path.join(folder, relativeFile);
  const existed = assertWritableFile(file);
  const current = existed ? fs.readFileSync(file, 'utf8') : '';
  const endpoint = parsedUrl.toString();

  let next;
  if (key === 'codex') {
    next = mergeCodexToml(current, endpoint, token, mode, caFile);
  } else {
    let document = {};
    if (current.trim()) {
      try {
        document = JSON.parse(current);
      } catch {
        throw new ExternalMcpInstallError(`${relativeFile} is not valid JSON; fix or remove it first`, 409);
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new ExternalMcpInstallError(`${relativeFile} must contain a JSON object`, 409);
      }
    }
    const servers = document.mcpServers && typeof document.mcpServers === 'object' ? document.mcpServers : {};
    next = `${JSON.stringify({ ...document, mcpServers: { ...servers, [SERVER_NAME]: jsonEntry(key, endpoint, token, mode, caFile) } }, null, 2)}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return { target: key, file, relativeFile, existed, tokenEnv: EXTERNAL_MCP_TOKEN_ENV, tokenWritten: Boolean(token), mode: String(mode) };
}

/**
 * @typedef {{ folder: string, target: string, relativeFile: string, mode: 'http' | 'stdio',
 *   url: string, tokenInFile: boolean }} ExternalMcpInstallRecord
 */

/** @param {unknown} value */
function literalToken(value) {
  const text = String(value || '').replace(/^Bearer\s+/i, '');
  return Boolean(text) && !/^\$\{/.test(text);
}

/**
 * Inspect the `cretli` entry of one config file. Never returns the token itself.
 *
 * @param {string} key
 * @param {string} text
 * @returns {{ mode: 'http' | 'stdio', url: string, tokenInFile: boolean } | null}
 */
function parseInstalledEntry(key, text) {
  if (key === 'codex') {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.trim() === `[mcp_servers.${SERVER_NAME}]`);
    if (start === -1) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\[/.test(lines[i]) && !lines[i].trim().startsWith(`[mcp_servers.${SERVER_NAME}.`)) { end = i; break; }
    }
    const block = lines.slice(start + 1, end).join('\n');
    const stdio = /^\s*command\s*=/m.test(block);
    const url = (stdio ? /CRETLI_MCP_URL\s*=\s*"([^"]*)"/ : /^\s*url\s*=\s*"([^"]*)"/m).exec(block)?.[1] || '';
    const tokenInFile = stdio
      ? new RegExp(`${EXTERNAL_MCP_TOKEN_ENV}\\s*=\\s*"[^"]+"`).test(block)
      : /Authorization\s*=\s*"Bearer [^"]+"/.test(block);
    return { mode: stdio ? 'stdio' : 'http', url, tokenInFile };
  }
  let entry;
  try {
    entry = JSON.parse(text)?.mcpServers?.[SERVER_NAME];
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  if (entry.command) {
    return { mode: 'stdio', url: String(entry.env?.CRETLI_MCP_URL || ''), tokenInFile: literalToken(entry.env?.[EXTERNAL_MCP_TOKEN_ENV]) };
  }
  return { mode: 'http', url: String(entry.url || ''), tokenInFile: literalToken(entry.headers?.Authorization) };
}

/**
 * Lists where the Cretli MCP entry is installed in the given folders (read-only).
 *
 * @param {string[]} folders Absolute folder paths.
 * @returns {ExternalMcpInstallRecord[]}
 */
export function scanExternalMcpInstalls(folders) {
  /** @type {ExternalMcpInstallRecord[]} */
  const found = [];
  for (const folder of folders) {
    if (!path.isAbsolute(folder)) continue;
    for (const target of EXTERNAL_MCP_INSTALL_TARGETS) {
      const relativeFile = TARGET_FILES[/** @type {keyof typeof TARGET_FILES} */ (target)];
      const file = path.join(folder, relativeFile);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const entry = parseInstalledEntry(target, fs.readFileSync(file, 'utf8'));
        if (entry) found.push({ folder, target, relativeFile, ...entry });
      } catch {
        // Missing or unreadable file: nothing installed here.
      }
    }
  }
  return found;
}
