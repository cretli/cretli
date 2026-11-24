/**
 * One-click connect of an MCP client running on the Cretli machine: a managed
 * external client (lib/mcp/mcp-external-clients.js) plus the target's config
 * for the local stdio bridge, pointed at the self-renewing token file.
 * Shared by Settings → MCP → Connect and the Remote Control operator chats.
 */

import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { resolveDataPath } from '../runtime-paths.js';
import {
  createExternalMcpManagedClient,
  findExternalMcpManagedClients,
  listExternalMcpClients,
  listLiveManagedClients,
  revokeExternalMcpClient,
  setExternalMcpClientPermissionGrant,
  setExternalMcpClientServerApproval,
  transferExternalMcpClientPermissions,
} from './mcp-external-clients.js';
import {
  applyClaudePermissionProfile,
  approveClaudeProjectServer,
  CLAUDE_LOCAL_SETTINGS_FILE,
  ExternalMcpInstallError,
  installExternalMcpConfig,
  releaseClaudePermissionGrant,
  unapproveClaudeProjectServer,
} from './mcp-external-install.js';
import { CLAUDE_RULE_LISTS, effectiveGrant, mergeGrants, normalizePermissionProfile } from './claude-permission-profiles.js';

const MCP_PATH = '/mcp';
/** Names given to a connected client per target. */
export const CONNECT_CLIENT_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' });

/**
 * Cretli's HTTPS certificate when it is present and parses, else null.
 *
 * @returns {{ file: string, cert: X509Certificate } | null}
 */
function cretliCertificate() {
  const file = path.resolve(process.env.SSL_CERT_PATH || resolveDataPath('cert.pem'));
  try {
    return { file, cert: new X509Certificate(fs.readFileSync(file)) };
  } catch {
    return null;
  }
}

/**
 * Endpoint and CA file for a bridge running on this machine. Loopback keeps
 * it working with LAN access off; `host` is the fallback when the HTTPS
 * certificate covers neither 127.0.0.1 nor localhost.
 *
 * @param {{ secure: boolean, port: number | string | undefined, host?: string }} server
 * @returns {{ url: string, caFile: string }}
 */
export function resolveLocalBridgeEndpoint({ secure, port, host = '' }) {
  if (!secure) return { url: `http://127.0.0.1:${port}${MCP_PATH}`, caFile: '' };
  const certificate = cretliCertificate();
  if (!certificate) throw new ExternalMcpInstallError('The Cretli HTTPS certificate is missing or invalid', 409);
  if (certificate.cert.checkIP('127.0.0.1')) return { url: `https://127.0.0.1:${port}${MCP_PATH}`, caFile: certificate.file };
  if (certificate.cert.checkHost('localhost')) return { url: `https://localhost:${port}${MCP_PATH}`, caFile: certificate.file };
  if (!host) throw new ExternalMcpInstallError('The Cretli HTTPS certificate covers neither 127.0.0.1 nor localhost', 409);
  return { url: `https://${host}${MCP_PATH}`, caFile: certificate.file };
}

/**
 * Legacy marker of a grant, still returned on the client for older callers:
 * `added` when Cretli wrote something, `existing` when the profile's rules were
 * all there already, empty for `prompt`.
 *
 * @param {import('./claude-permission-profiles.js').ClaudePermissionGrant} grant
 * @returns {'added' | 'existing' | ''}
 */
function legacyMarker(grant) {
  const owns = grant.defaultMode.owned || CLAUDE_RULE_LISTS.some((list) => grant.addedRules[/** @type {'allow'} */ (list)].length);
  if (owns) return 'added';
  return grant.profile === 'prompt' ? '' : 'existing';
}

/** @param {import('./claude-permission-profiles.js').ClaudePermissionGrant} grant */
function ownsNothing(grant) {
  return !grant.defaultMode.owned && CLAUDE_RULE_LISTS.every((list) => !grant.addedRules[/** @type {'allow'} */ (list)].length);
}

/**
 * Create a managed client for `target` in `folder` and write its config.
 * A previous managed connection of the same target in the same folder is
 * revoked once the new config is in place; on failure nothing stays live.
 *
 * `permissionProfile` (Claude Code only) merges a permission profile into
 * `.claude/settings.local.json` (see claude-permission-profiles.js); the older
 * `allowTools` boolean maps to `cretli_tools` / `prompt`. Both omitted: the
 * settings are left as they are and the replaced connection's grant carries over.
 * The rules Cretli added are recorded on the new client so a later release
 * removes only those.
 *
 * @param {{ target: string, folder: string, mode?: unknown, endpoint: { url: string, caFile: string }, allowTools?: boolean, permissionProfile?: unknown }} input
 */
export function connectExternalMcpClient({ target, folder, mode, endpoint, allowTools, permissionProfile }) {
  if (!Object.hasOwn(CONNECT_CLIENT_NAMES, target)) {
    throw new ExternalMcpInstallError(`target must be one of: ${Object.keys(CONNECT_CLIENT_NAMES).join(', ')}`);
  }
  if (!folder || !path.isAbsolute(folder)) throw new ExternalMcpInstallError('folder must be an absolute path');
  const normalized = normalizePermissionProfile(permissionProfile, { allowTools });
  if ('error' in normalized) throw new ExternalMcpInstallError(normalized.error);
  const resolved = path.resolve(folder);
  const previousRows = target === 'claude' ? listLiveManagedClients(target, resolved) : [];
  const previous = findExternalMcpManagedClients(target, resolved);
  const previousGrant = mergeGrants(previousRows.map((row) => effectiveGrant(row)));
  let created;
  try {
    created = createExternalMcpManagedClient({
      name: CONNECT_CLIENT_NAMES[/** @type {keyof typeof CONNECT_CLIENT_NAMES} */ (target)],
      workspaceFolder: resolved,
      mode,
      installTarget: target,
      installFolder: resolved,
    });
    const result = installExternalMcpConfig({
      target,
      folder: resolved,
      mode: 'stdio',
      url: endpoint.url,
      caFile: endpoint.caFile,
      tokenFile: created.tokenFile,
    });
    const applied = target === 'claude' ? applyPermissionProfile(resolved, normalized.profile, previousGrant) : null;
    if (applied) {
      setExternalMcpClientPermissionGrant(created.client.id, applied.grant.profile === 'prompt' && ownsNothing(applied.grant) ? null : applied.grant);
    }
    const approval = target === 'claude' ? ensureServerApproval(created.client.id, resolved, previousRows) : null;
    for (const id of previous) {
      // Ownership was inherited by the new client: a stale grant on the replaced row must not
      // let a later release remove rules the user re-added.
      if (target === 'claude') setExternalMcpClientPermissionGrant(id, null);
      revokeExternalMcpClient(id);
    }
    const marker = applied ? legacyMarker(applied.grant) : '';
    return {
      client: {
        ...created.client,
        ...(marker ? { claudeToolPermission: marker } : {}),
        ...(applied ? { claudePermissionGrant: applied.grant } : {}),
      },
      target,
      folder: resolved,
      ...result,
      replaced: previous.length,
      url: endpoint.url,
      toolPermission: applied?.report || null,
      serverApproval: approval,
      permissionGrant: applied ? { ...applied.grant, gitIgnored: applied.gitIgnored, relativeFile: CLAUDE_LOCAL_SETTINGS_FILE, ...(applied.error ? { error: applied.error } : {}) } : null,
    };
  } catch (err) {
    if (created) revokeExternalMcpClient(created.client.id);
    throw err;
  }
}

/**
 * @param {string} folder
 * @param {import('./claude-permission-profiles.js').ClaudePermissionProfileName | undefined} profile
 * @param {import('./claude-permission-profiles.js').ClaudePermissionGrant} previousGrant merged grants of the replaced connections
 * @returns {{ grant: import('./claude-permission-profiles.js').ClaudePermissionGrant, report: object | null, gitIgnored: boolean | null, error?: string }}
 */
function applyPermissionProfile(folder, profile, previousGrant) {
  if (profile === undefined) return { grant: previousGrant, report: null, gitIgnored: null };
  try {
    const result = applyClaudePermissionProfile(folder, profile, previousGrant);
    const { inserted, defaultModeKept, file, relativeFile, gitIgnored, ...grant } = result;
    const removed = profile === 'prompt' && !ownsNothing(previousGrant);
    return {
      grant,
      gitIgnored,
      report: removed
        ? { allowed: false, removed: true }
        : {
          allowed: profile !== 'prompt',
          profile,
          added: inserted > 0,
          file,
          relativeFile,
          gitIgnored,
          ...(defaultModeKept === undefined ? {} : { defaultModeKept }),
        },
    };
  } catch (err) {
    // The MCP connection itself is in place; report the settings problem instead of undoing it.
    const error = err instanceof Error ? err.message : String(err);
    return { grant: previousGrant, gitIgnored: null, error, report: { allowed: false, error } };
  }
}

/**
 * Undo what Cretli wrote into `.claude/settings.local.json` for a managed
 * Claude Code connection. Order matters (see the plan): snapshot the row,
 * compute the other live clients with this id excluded, record transfers on
 * the clients that still need a rule, edit the file, then clear the grant.
 * A rule or `defaultMode` another live client's profile requires is kept.
 * Idempotent: a cleared grant is a no-op.
 *
 * @param {Record<string, any>} client managed client row (`id`, `managed`, `installTarget`, `installFolder`, grant fields)
 * @returns {{ removed: string[], failed?: string }} what left the settings file; `failed` when the file could
 *   not be read, in which case the grant is kept so a later release (after the file is repaired) still reverts
 */
export function releaseClientPermission(client) {
  if (!client?.managed || client.installTarget !== 'claude' || !client.installFolder) return { removed: [] };
  const row = listExternalMcpClients().find((entry) => entry.id === client.id) || client;
  const grant = effectiveGrant(row);
  if (ownsNothing(grant)) {
    // Nothing to take back, but the connection must stop declaring the old profile.
    setExternalMcpClientPermissionGrant(client.id, null);
    return { removed: [] };
  }
  const remaining = listLiveManagedClients('claude', client.installFolder)
    .filter((entry) => entry.id !== client.id)
    .map((entry) => ({ id: entry.id, profile: effectiveGrant(entry).profile }));
  const { removed, failed } = releaseClaudePermissionGrant(
    client.installFolder,
    grant,
    remaining,
    (transfer) => transferExternalMcpClientPermissions(transfer, effectiveGrant),
  );
  if (failed) return { removed, failed };
  setExternalMcpClientPermissionGrant(client.id, null);
  return { removed };
}

/**
 * Boolean form of {@link releaseClientPermission}.
 *
 * @param {Record<string, any>} client
 * @returns {boolean} true when something was removed from the settings file
 */
export function releaseClaudeToolPermission(client) {
  return releaseClientPermission(client).removed.length > 0;
}

/**
 * Make sure Claude Code may start the `cretli` server of `folder` (see
 * approveClaudeProjectServer) and record on `clientId` when Cretli wrote the
 * approval, or inherited it from `previousRows`. Never throws: a settings file
 * that cannot be changed is reported instead.
 *
 * @param {string} clientId
 * @param {string} folder
 * @param {Array<Record<string, any>>} [previousRows] replaced connections in the folder
 * @returns {{ approved: boolean, added: boolean, error?: string }}
 */
export function ensureServerApproval(clientId, folder, previousRows = []) {
  try {
    const { added } = approveClaudeProjectServer(folder);
    const owned = added || previousRows.some((row) => row.claudeServerApproval === 'added');
    if (owned) setExternalMcpClientServerApproval(clientId, 'added');
    for (const row of previousRows) if (row.id !== clientId && row.claudeServerApproval) setExternalMcpClientServerApproval(row.id, '');
    return { approved: true, added };
  } catch (err) {
    return { approved: false, added: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Take back the `cretli` approval when the revoked connection owned it and no
 * other live Claude Code connection remains in the folder.
 *
 * @param {Record<string, any>} client managed client row
 * @returns {boolean} true when the approval was removed
 */
export function releaseServerApproval(client) {
  if (!client?.managed || client.installTarget !== 'claude' || client.claudeServerApproval !== 'added' || !client.installFolder) return false;
  const others = listLiveManagedClients('claude', client.installFolder).filter((entry) => entry.id !== client.id);
  if (others.length) {
    // The approval stays for the remaining connection, and so does the duty to take it back.
    setExternalMcpClientServerApproval(others[0].id, 'added');
    setExternalMcpClientServerApproval(client.id, '');
    return false;
  }
  const removed = unapproveClaudeProjectServer(client.installFolder);
  setExternalMcpClientServerApproval(client.id, '');
  return removed;
}

/**
 * The live managed connection of `target` in `folder`, if any.
 *
 * @param {string} target
 * @param {string} folder
 */
export function activeManagedConnection(target, folder) {
  const ids = new Set(findExternalMcpManagedClients(target, path.resolve(folder)));
  return listExternalMcpClients().find((client) => ids.has(client.id)) || null;
}
