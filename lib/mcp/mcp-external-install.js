/**
 * Writes the Cretli MCP client configuration into a project folder for
 * Claude Code, Codex or Cursor. Without a token each file references the
 * CRETLI_MCP_TOKEN environment variable (safe to commit); with a freshly
 * issued token the file carries it, so the tool works with no extra setup.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_OWNED_DEFAULT_MODE,
  CLAUDE_RULE_LISTS,
  CLAUDE_TOOL_PERMISSION_RULE,
  emptyGrant,
  emptyRuleSet,
  profileRequires,
} from './claude-permission-profiles.js';

export const EXTERNAL_MCP_INSTALL_TARGETS = Object.freeze(['claude', 'codex', 'cursor']);
export const EXTERNAL_MCP_TOKEN_ENV = 'CRETLI_MCP_TOKEN';
/** Bridge variable naming a file the bridge re-reads on every request (managed clients). */
export const EXTERNAL_MCP_TOKEN_FILE_ENV = 'CRETLI_MCP_TOKEN_FILE';
export const EXTERNAL_MCP_INSTALL_MODES = Object.freeze(['http', 'stdio']);
/** Name of the Cretli entry in every client config; also the base of its tool-permission rule. */
export const EXTERNAL_MCP_SERVER_NAME = 'cretli';
const SERVER_NAME = EXTERNAL_MCP_SERVER_NAME;
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
function jsonEntry(target, url, token, mode = 'http', caFile = '', tokenFile = '') {
  if (mode === 'stdio') {
    const ref = `\${${target === 'cursor' ? 'env:' : ''}${EXTERNAL_MCP_TOKEN_ENV}}`;
    const auth = tokenFile ? { [EXTERNAL_MCP_TOKEN_FILE_ENV]: tokenFile } : { [EXTERNAL_MCP_TOKEN_ENV]: token || ref };
    return {
      command: 'node',
      args: [BRIDGE_SCRIPT],
      env: { CRETLI_MCP_URL: url, ...auth, ...(caFile ? { CRETLI_MCP_CA_FILE: caFile } : {}) },
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
function codexBlock(url, token, mode = 'http', caFile = '', tokenFile = '') {
  if (mode === 'stdio') {
    const auth = tokenFile
      ? `, ${EXTERNAL_MCP_TOKEN_FILE_ENV} = ${tomlString(tokenFile)}`
      : (token ? `, ${EXTERNAL_MCP_TOKEN_ENV} = ${tomlString(token)}` : '');
    const env = `env = { CRETLI_MCP_URL = ${tomlString(url)}${auth}${caFile ? `, CRETLI_MCP_CA_FILE = ${tomlString(caFile)}` : ''} }`;
    const vars = token || tokenFile ? '' : `env_vars = [${tomlString(EXTERNAL_MCP_TOKEN_ENV)}]\n`;
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
export function mergeCodexToml(existing, url, token, mode = 'http', caFile = '', tokenFile = '') {
  const block = codexBlock(url, token, mode, caFile, tokenFile);
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
 * @param {{ target: unknown, folder: string, url: unknown, token?: string, mode?: string, caFile?: string, tokenFile?: string }} input
 *   `tokenFile` (stdio only) makes the bridge read the token from that file instead of the config.
 * @returns {{ target: string, file: string, relativeFile: string, existed: boolean, tokenEnv: string, tokenWritten: boolean, mode: string }}
 */
export function installExternalMcpConfig({ target, folder, url, token, mode = 'http', caFile = '', tokenFile = '' }) {
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
  if (tokenFile && (mode !== 'stdio' || token)) {
    throw new ExternalMcpInstallError('A token file requires stdio mode and no literal token');
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
    next = mergeCodexToml(current, endpoint, token, mode, caFile, tokenFile);
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
    next = `${JSON.stringify({ ...document, mcpServers: { ...servers, [SERVER_NAME]: jsonEntry(key, endpoint, token, mode, caFile, tokenFile) } }, null, 2)}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return { target: key, file, relativeFile, existed, tokenEnv: EXTERNAL_MCP_TOKEN_ENV, tokenWritten: Boolean(token || tokenFile), mode: String(mode) };
}

/**
 * @typedef {{ folder: string, target: string, relativeFile: string, mode: 'http' | 'stdio',
 *   url: string, tokenInFile: boolean, managed: boolean }} ExternalMcpInstallRecord
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
 * @returns {{ mode: 'http' | 'stdio', url: string, tokenInFile: boolean, managed: boolean } | null}
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
    const managed = stdio && new RegExp(`${EXTERNAL_MCP_TOKEN_FILE_ENV}\\s*=\\s*"[^"]+"`).test(block);
    return { mode: stdio ? 'stdio' : 'http', url, tokenInFile: tokenInFile || managed, managed };
  }
  let entry;
  try {
    entry = JSON.parse(text)?.mcpServers?.[SERVER_NAME];
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  if (entry.command) {
    const managed = Boolean(entry.env?.[EXTERNAL_MCP_TOKEN_FILE_ENV]);
    return { mode: 'stdio', url: String(entry.env?.CRETLI_MCP_URL || ''), tokenInFile: managed || literalToken(entry.env?.[EXTERNAL_MCP_TOKEN_ENV]), managed };
  }
  return { mode: 'http', url: String(entry.url || ''), tokenInFile: literalToken(entry.headers?.Authorization), managed: false };
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

/** Claude Code permission rule that allows every tool of the Cretli MCP server (defined with the profiles). */
export { CLAUDE_TOOL_PERMISSION_RULE };
/** Claude Code's per-folder local settings, normally kept out of version control. */
export const CLAUDE_LOCAL_SETTINGS_FILE = path.join('.claude', 'settings.local.json');

/**
 * Reads `<folder>/.claude/settings.local.json`. A missing file is an empty
 * object; an unreadable or invalid one is refused so it is never overwritten.
 *
 * @param {string} folder
 * @returns {{ file: string, existed: boolean, document: Record<string, any> }}
 */
function readClaudeLocalSettings(folder) {
  const file = path.join(folder, CLAUDE_LOCAL_SETTINGS_FILE);
  const existed = assertWritableFile(file);
  if (!existed) return { file, existed, document: {} };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { file, existed, document: {} };
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE} is not valid JSON; fix it first, it was left unchanged`, 409);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE} must contain a JSON object; it was left unchanged`, 409);
  }
  if (document.permissions !== undefined && (typeof document.permissions !== 'object' || Array.isArray(document.permissions) || document.permissions === null)) {
    throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE}: "permissions" must be an object; it was left unchanged`, 409);
  }
  for (const list of CLAUDE_RULE_LISTS) {
    if (document.permissions?.[list] !== undefined && !Array.isArray(document.permissions[list])) {
      throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE}: "permissions.${list}" must be an array; it was left unchanged`, 409);
    }
  }
  if (document.permissions?.defaultMode !== undefined && typeof document.permissions.defaultMode !== 'string') {
    throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE}: "permissions.defaultMode" must be a string; it was left unchanged`, 409);
  }
  return { file, existed, document };
}

/**
 * @param {string} file
 * @param {Record<string, any>} document
 */
function writeJsonFileAtomic(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/**
 * Whether git ignores the local settings file: true / false, or null when the
 * folder is not a git work tree (or git is unavailable).
 *
 * @param {string} folder
 * @returns {boolean | null}
 */
export function isClaudeLocalSettingsIgnored(folder) {
  try {
    execFileSync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore', timeout: 5000 });
  } catch {
    return null;
  }
  try {
    execFileSync('git', ['-C', folder, 'check-ignore', '-q', CLAUDE_LOCAL_SETTINGS_FILE], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.status === 1 ? false : null;
  }
}

/**
 * Allow the Cretli MCP tools without a prompt in this folder: merges
 * `mcp__cretli` into `permissions.allow` of `.claude/settings.local.json`,
 * keeping every other key and rule. Idempotent.
 *
 * @param {string} folder
 * @returns {{ added: boolean, file: string, relativeFile: string, gitIgnored: boolean | null }}
 *   `added` is false when the rule was already there (then it is not Cretli's to remove).
 */
export function addClaudeToolPermission(folder) {
  const { file, document } = readClaudeLocalSettings(folder);
  const allow = Array.isArray(document.permissions?.allow) ? document.permissions.allow : [];
  const added = !allow.includes(CLAUDE_TOOL_PERMISSION_RULE);
  if (added) {
    document.permissions = { ...(document.permissions || {}), allow: [...allow, CLAUDE_TOOL_PERMISSION_RULE] };
    writeJsonFileAtomic(file, document);
  }
  return { added, file, relativeFile: CLAUDE_LOCAL_SETTINGS_FILE, gitIgnored: isClaudeLocalSettingsIgnored(folder) };
}

/**
 * Remove only the Cretli rule from the folder's local settings; everything
 * else stays. A missing file is a no-op.
 *
 * @param {string} folder
 * @returns {boolean} true when the rule was removed
 */
export function removeClaudeToolPermission(folder) {
  const { file, existed, document } = readClaudeLocalSettings(folder);
  if (!existed) return false;
  const allow = Array.isArray(document.permissions?.allow) ? document.permissions.allow : [];
  if (!allow.includes(CLAUDE_TOOL_PERMISSION_RULE)) return false;
  document.permissions.allow = allow.filter((rule) => rule !== CLAUDE_TOOL_PERMISSION_RULE);
  writeJsonFileAtomic(file, document);
  return true;
}

/**
 * Write a permission profile into `.claude/settings.local.json`, keeping every
 * other key and rule. Only rules that were missing are recorded as Cretli's
 * (`addedRules`); rules the user already had are never recorded, so they are
 * never removed. Rules of `previousGrant` the new profile no longer wants are
 * removed in the same atomic write. Idempotent: no write when nothing changes.
 *
 * @param {string} folder
 * @param {string} profileName
 * @param {import('./claude-permission-profiles.js').ClaudePermissionGrant} [previousGrant]
 * @returns {import('./claude-permission-profiles.js').ClaudePermissionGrant & {
 *   file: string, relativeFile: string, gitIgnored: boolean | null, inserted: number, defaultModeKept?: string }}
 */
export function applyClaudePermissionProfile(folder, profileName, previousGrant = emptyGrant()) {
  const want = profileRequires(profileName);
  const prev = previousGrant;
  const file = path.join(folder, CLAUDE_LOCAL_SETTINGS_FILE);
  const base = { file, relativeFile: CLAUDE_LOCAL_SETTINGS_FILE };
  const wantsNothing = !want.allow.length && !want.ask.length && !want.deny.length && !want.defaultMode;
  const hadNothing = !prev.defaultMode.owned && CLAUDE_RULE_LISTS.every((list) => !prev.addedRules[/** @type {'allow'} */ (list)].length);
  if (wantsNothing && hadNothing) {
    return { ...emptyGrant(), ...base, gitIgnored: null, inserted: 0 };
  }
  const { document } = readClaudeLocalSettings(folder);
  const permissions = { ...(document.permissions || {}) };
  const addedRules = emptyRuleSet();
  let inserted = 0;
  let changed = false;
  for (const list of CLAUDE_RULE_LISTS) {
    const key = /** @type {'allow' | 'ask' | 'deny'} */ (list);
    const current = Array.isArray(permissions[key]) ? permissions[key] : [];
    const ours = prev.addedRules[key];
    const next = current.filter((rule) => !(ours.includes(rule) && !want[key].includes(rule)));
    for (const rule of want[key]) {
      if (!next.includes(rule)) {
        next.push(rule);
        addedRules[key].push(rule);
        inserted += 1;
      } else if (ours.includes(rule)) {
        addedRules[key].push(rule);
      }
    }
    if (next.length !== current.length || next.some((rule, i) => rule !== current[i])) {
      permissions[key] = next;
      changed = true;
    }
  }
  const currentMode = permissions.defaultMode;
  /** @type {{ owned: boolean, previous: string | null }} */
  let defaultMode = { owned: false, previous: null };
  let defaultModeKept;
  if (want.defaultMode) {
    if (currentMode === undefined) {
      permissions.defaultMode = want.defaultMode;
      defaultMode = { owned: true, previous: prev.defaultMode.owned ? prev.defaultMode.previous : null };
      changed = true;
    } else if (currentMode === want.defaultMode) {
      if (prev.defaultMode.owned) defaultMode = { owned: true, previous: prev.defaultMode.previous };
    } else {
      defaultModeKept = String(currentMode);
    }
  } else if (prev.defaultMode.owned && currentMode === CLAUDE_OWNED_DEFAULT_MODE) {
    if (prev.defaultMode.previous === null) delete permissions.defaultMode;
    else permissions.defaultMode = prev.defaultMode.previous;
    changed = true;
  }
  if (changed) {
    writeJsonFileAtomic(file, { ...document, permissions });
  }
  return {
    profile: /** @type {any} */ (profileName),
    addedRules,
    defaultMode,
    ...base,
    gitIgnored: isClaudeLocalSettingsIgnored(folder),
    inserted,
    ...(defaultModeKept === undefined ? {} : { defaultModeKept }),
  };
}

/**
 * Decide what releasing `grant` does while other live clients stay in the
 * folder. A rule a remaining client's profile still requires is kept and handed
 * to the first such client (`transfer`); the rest is removed. Pure.
 *
 * @param {import('./claude-permission-profiles.js').ClaudePermissionGrant} grant
 * @param {Array<{ id: string, profile: string }>} remainingClients other live managed clients, creation order
 * @returns {{
 *   transfer: { rules: Array<{ clientId: string, rule: string, list: 'allow' | 'ask' | 'deny' }>, defaultMode: { clientId: string, previous: string | null } | null },
 *   remove: import('./claude-permission-profiles.js').ClaudeRuleSet,
 *   restoreDefaultMode: { previous: string | null } | null,
 * }}
 */
export function planClaudePermissionRelease(grant, remainingClients) {
  const transfer = { rules: /** @type {any[]} */ ([]), defaultMode: /** @type {any} */ (null) };
  const remove = emptyRuleSet();
  for (const list of CLAUDE_RULE_LISTS) {
    const key = /** @type {'allow' | 'ask' | 'deny'} */ (list);
    for (const rule of grant.addedRules[key]) {
      const receiver = remainingClients.find((client) => profileRequires(client.profile)[key].includes(rule));
      if (receiver) transfer.rules.push({ clientId: receiver.id, rule, list: key });
      else remove[key].push(rule);
    }
  }
  let restoreDefaultMode = null;
  if (grant.defaultMode.owned) {
    const receiver = remainingClients.find((client) => profileRequires(client.profile).defaultMode);
    if (receiver) transfer.defaultMode = { clientId: receiver.id, previous: grant.defaultMode.previous };
    else restoreDefaultMode = { previous: grant.defaultMode.previous };
  }
  return { transfer, remove, restoreDefaultMode };
}

/**
 * Release a grant: plan, let `persistTransfer` record the transfers on the
 * receiving clients, then edit the file. Missing file or rule is a no-op; an
 * invalid file is left untouched and not thrown.
 *
 * @param {string} folder
 * @param {import('./claude-permission-profiles.js').ClaudePermissionGrant} grant
 * @param {Array<{ id: string, profile: string }>} remainingClients
 * @param {(transfer: ReturnType<typeof planClaudePermissionRelease>['transfer']) => void} [persistTransfer]
 * @returns {{ transfer: ReturnType<typeof planClaudePermissionRelease>['transfer'], removed: string[], failed?: string }}
 *   `failed` carries the reason when the settings file could not be read (invalid JSON or types): nothing was
 *   written or transferred, so the caller must keep the grant and retry once the file is repaired.
 */
export function releaseClaudePermissionGrant(folder, grant, remainingClients, persistTransfer) {
  const plan = planClaudePermissionRelease(grant, remainingClients);
  /** @type {string[]} */
  const removed = [];
  let settings;
  try {
    settings = readClaudeLocalSettings(folder);
  } catch (err) {
    return { transfer: plan.transfer, removed, failed: err instanceof Error ? err.message : String(err) };
  }
  if (persistTransfer && (plan.transfer.rules.length || plan.transfer.defaultMode)) persistTransfer(plan.transfer);
  if (!settings.existed) return { transfer: plan.transfer, removed };
  const { file, document } = settings;
  const permissions = { ...(document.permissions || {}) };
  let changed = false;
  for (const list of CLAUDE_RULE_LISTS) {
    const key = /** @type {'allow' | 'ask' | 'deny'} */ (list);
    const current = Array.isArray(permissions[key]) ? permissions[key] : [];
    const next = current.filter((rule) => !plan.remove[key].includes(rule));
    if (next.length !== current.length) {
      for (const rule of current) if (!next.includes(rule)) removed.push(rule);
      permissions[key] = next;
      changed = true;
    }
  }
  if (plan.restoreDefaultMode && permissions.defaultMode === CLAUDE_OWNED_DEFAULT_MODE) {
    if (plan.restoreDefaultMode.previous === null) delete permissions.defaultMode;
    else permissions.defaultMode = plan.restoreDefaultMode.previous;
    removed.push('defaultMode');
    changed = true;
  }
  if (changed) writeJsonFileAtomic(file, { ...document, permissions });
  return { transfer: plan.transfer, removed };
}

/**
 * Claude Code starts a server from a project `.mcp.json` only after it was
 * approved for the folder. An interactive session asks once and keeps the
 * answer in memory; a headless one (Remote Control, `--print`) never asks and
 * silently starts without the server. Approving `cretli` in the folder's
 * local settings (`enabledMcpjsonServers`) makes it load everywhere.
 *
 * @param {string} folder
 * @returns {{ added: boolean, file: string }} `added` false when it was already approved
 *   (listed, or `enableAllProjectMcpServers`), then it is not Cretli's to take back
 */
export function approveClaudeProjectServer(folder) {
  const { file, document } = readClaudeLocalSettings(folder);
  const list = document.enabledMcpjsonServers;
  if (list !== undefined && !Array.isArray(list)) {
    throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE}: "enabledMcpjsonServers" must be an array; it was left unchanged`, 409);
  }
  if (document.enableAllProjectMcpServers === true || (list || []).includes(SERVER_NAME)) return { added: false, file };
  writeJsonFileAtomic(file, { ...document, enabledMcpjsonServers: [...(list || []), SERVER_NAME] });
  return { added: true, file };
}

/**
 * Remove only the `cretli` approval; a missing file or entry is a no-op and an
 * invalid file is left untouched.
 *
 * @param {string} folder
 * @returns {boolean} true when the approval was removed
 */
export function unapproveClaudeProjectServer(folder) {
  let read;
  try {
    read = readClaudeLocalSettings(folder);
  } catch {
    return false;
  }
  const { file, existed, document } = read;
  const list = document.enabledMcpjsonServers;
  if (!existed || !Array.isArray(list) || !list.includes(SERVER_NAME)) return false;
  const rest = list.filter((name) => name !== SERVER_NAME);
  const next = { ...document, enabledMcpjsonServers: rest };
  // An empty list is what Cretli's approval alone created: drop it so the file is as it was.
  if (!rest.length) delete next.enabledMcpjsonServers;
  writeJsonFileAtomic(file, next);
  return true;
}

/** Self-repair script a resumed Claude Code session can run when its Cretli tools are missing. */
export const CLAUDE_HEAL_SCRIPT = fileURLToPath(new URL('../../scripts/cretli-mcp-heal.mjs', import.meta.url));

/** @param {unknown} hook */
function isHealHook(hook) {
  return Boolean(hook) && typeof hook === 'object' && String(/** @type {any} */ (hook).command || '').includes('cretli-mcp-heal.mjs');
}

/**
 * Add a SessionStart hook that tells every new or resumed session of the
 * folder how to restore the Cretli tools (scripts/cretli-mcp-heal.mjs).
 * Merged into `hooks.SessionStart` of `.claude/settings.local.json`; other
 * hooks and keys stay. Idempotent.
 *
 * @param {string} folder
 * @returns {{ added: boolean, file: string }} `added` false when the hook was already there
 */
export function addClaudeHealHook(folder) {
  const { file, document } = readClaudeLocalSettings(folder);
  const hooks = document.hooks;
  if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))) {
    throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE}: "hooks" must be an object; it was left unchanged`, 409);
  }
  const groups = hooks?.SessionStart;
  if (groups !== undefined && !Array.isArray(groups)) {
    throw new ExternalMcpInstallError(`${CLAUDE_LOCAL_SETTINGS_FILE}: "hooks.SessionStart" must be an array; it was left unchanged`, 409);
  }
  if ((groups || []).some((group) => Array.isArray(group?.hooks) && group.hooks.some(isHealHook))) return { added: false, file };
  const command = `node ${JSON.stringify(CLAUDE_HEAL_SCRIPT)} --hint`;
  writeJsonFileAtomic(file, {
    ...document,
    hooks: { ...(hooks || {}), SessionStart: [...(groups || []), { hooks: [{ type: 'command', command }] }] },
  });
  return { added: true, file };
}

/**
 * Remove only Cretli's SessionStart hook; empty containers it leaves behind
 * are dropped. Missing or invalid files are left alone.
 *
 * @param {string} folder
 * @returns {boolean} true when the hook was removed
 */
export function removeClaudeHealHook(folder) {
  let read;
  try {
    read = readClaudeLocalSettings(folder);
  } catch {
    return false;
  }
  const { file, existed, document } = read;
  const groups = document.hooks?.SessionStart;
  if (!existed || !Array.isArray(groups)) return false;
  let removed = false;
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks) || !group.hooks.some(isHealHook)) {
      kept.push(group);
      continue;
    }
    removed = true;
    const rest = group.hooks.filter((hook) => !isHealHook(hook));
    if (rest.length) kept.push({ ...group, hooks: rest });
  }
  if (!removed) return false;
  const hooks = { ...document.hooks, SessionStart: kept };
  if (!kept.length) delete hooks.SessionStart;
  const next = { ...document, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  writeJsonFileAtomic(file, next);
  return true;
}
