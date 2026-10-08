/**
 * Stable OpenRouter / bridge tool names: mcp__<runtime>__<tool>
 */

import { createHash } from 'node:crypto';
import { BUILTIN_CRETILI_SERVER_ID, toMcpRuntimeName } from './mcp-config.js';

const PREFIX = 'mcp__';

/** Harness function-name cap (e.g. OpenAI/DeepSeek ^[a-zA-Z0-9_-]{1,64}$). */
export const MCP_BUILTIN_TOOL_NAME_LIMIT = 64;

/** Bridge stdio server key exposed to DeepSeek/Codex-style harness adapters. */
export const MCP_CRETILI_BRIDGE_RUNTIME = 'cretli_bridge';

/** Outer bridge prefix before the encoded builtin-cretli tool name. */
export const MCP_CRETILI_BRIDGE_PREFIX = `${PREFIX}${MCP_CRETILI_BRIDGE_RUNTIME}__`;

/**
 * Legacy catalog names renamed to fit the harness limit without hash collisions.
 * Keys are former tool ids; values are the canonical names in CRETILI_MCP_TOOL_DEFS.
 */
export const MCP_TOOL_LEGACY_NAMES = Object.freeze({
  delegation_workflow_update: 'workflow_update',
  delegation_workflow_show: 'workflow_show',
  workspace_watcher_update: 'watcher_update',
  workspace_watcher_show: 'watcher_show',
  workspace_memory_add: 'wmem_add',
  workspace_memory_list: 'wmem_list',
  workspace_memory_delete: 'wmem_delete',
  watcher_scout_findings: 'scout_findings',
  watcher_scout_profiles: 'scout_profiles',
});

/** @type {Readonly<Record<string, string>>} */
export const MCP_TOOL_NEW_TO_LEGACY = Object.freeze(
  Object.fromEntries(
    Object.entries(MCP_TOOL_LEGACY_NAMES).map(([legacy, canonical]) => [canonical, legacy]),
  ),
);

/**
 * @param {string} serverId
 * @param {string} toolName
 * @returns {string}
 */
export function encodeMcpToolName(serverId, toolName) {
  const runtime = toMcpRuntimeName(serverId);
  const tool = String(toolName || '').trim() || 'tool';
  return `${PREFIX}${runtime}__${tool}`;
}

/**
 * Full name as bridge harnesses list it: mcp__cretli_bridge__mcp__cretli_builtincretl__<tool>.
 *
 * @param {string} toolName Canonical builtin tool id.
 * @returns {string}
 */
export function mcpBuiltinToolBridgeEncodedName(toolName) {
  return `${MCP_CRETILI_BRIDGE_PREFIX}${encodeMcpToolName(BUILTIN_CRETILI_SERVER_ID, toolName)}`;
}

/**
 * @param {string} toolName Canonical builtin tool id.
 * @returns {number}
 */
export function mcpBuiltinToolEncodedLength(toolName) {
  return mcpBuiltinToolBridgeEncodedName(toolName).length;
}

/**
 * Simulates harness-side truncation when the encoded name exceeds the limit:
 * keep the prefix through the last `__`, shorten the final segment to head5_hash12.
 *
 * @param {string} encodedName
 * @returns {string}
 */
export function simulateHarnessTruncatedEncodedName(encodedName) {
  const full = String(encodedName || '');
  if (full.length <= MCP_BUILTIN_TOOL_NAME_LIMIT) return full;
  const lastSep = full.lastIndexOf('__');
  if (lastSep < 0) {
    const hash = createHash('sha256').update(full).digest('hex').slice(0, 12);
    return `${full.slice(0, 5)}_${hash}`;
  }
  const prefix = full.slice(0, lastSep + 2);
  const toolPart = full.slice(lastSep + 2);
  const hash = createHash('sha256').update(toolPart).digest('hex').slice(0, 12);
  return `${prefix}${toolPart.slice(0, 5)}_${hash}`;
}

/**
 * @param {unknown} encoded
 * @returns {{ runtimeName: string, toolName: string } | null}
 */
export function decodeMcpToolName(encoded) {
  const name = String(encoded || '').trim();
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  return {
    runtimeName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}

/**
 * Strip MCP prefixes to a basename and map legacy ids to the current catalog name.
 * Hashed harness aliases and unknown names are returned unchanged (no fuzzy match).
 *
 * @param {unknown} name
 * @returns {string}
 */
export function resolveMcpBuiltinToolName(name) {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  let basename = raw;
  if (basename.includes('__')) {
    basename = basename.split('__').pop() || basename;
  }
  const slash = basename.lastIndexOf('/');
  const dot = basename.lastIndexOf('.');
  const sep = Math.max(slash, dot);
  if (sep >= 0) basename = basename.slice(sep + 1);
  if (Object.prototype.hasOwnProperty.call(MCP_TOOL_LEGACY_NAMES, basename)) {
    return MCP_TOOL_LEGACY_NAMES[basename];
  }
  return basename;
}

/**
 * Runtime marker of the builtin Cretli server inside an encoded name, e.g.
 * `mcp__cretli_builtincretl__`. Derived, never a literal, so a rename of the
 * builtin server id cannot silently widen a gate.
 */
const BUILTIN_CRETILI_RUNTIME_MARKER = `${PREFIX}${toMcpRuntimeName(BUILTIN_CRETILI_SERVER_ID)}__`;

/**
 * Harnesses do not only shorten the tool segment: some rewrite the middle of a
 * long name too (observed live as `mcp__cretli_bridge__mcp__cre___tincretl__…`),
 * so an exact runtime comparison would deny a legitimate builtin call. Identity
 * is therefore "this chain carries a Cretli runtime token", which still rejects
 * a foreign server (`mcp__github__todo_list`, `mcp.acme.todo_list`). Callers must
 * additionally match the resolved basename against the catalog, so an unknown
 * name is never treated as builtin.
 *
 * @param {string[]} runtimeSegments segments before the tool name
 * @returns {boolean}
 */
function isCretliRuntimeChain(runtimeSegments) {
  let sawCretli = false;
  for (const segment of runtimeSegments) {
    const normalized = segment.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized || normalized === 'mcp') continue;
    // `toMcpRuntimeName` of an external server id is `cretli_<12 hex>`; the
    // builtin id never takes that shape, so a bridge-wrapped external server is
    // foreign even though it carries a Cretli token.
    if (/^cretli[0-9a-f]{12}$/.test(normalized)) return false;
    if (normalized.includes('cretli')) sawCretli = true;
  }
  return sawCretli;
}

/**
 * True only for names the builtin Cretli catalog can own: a bare tool name (no
 * MCP wrapper — some harnesses present builtins bare) or a chain whose runtime
 * segments carry a Cretli token and none resolves to an external server id.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isCretliBuiltinToolName(name) {
  const raw = String(name || '').trim();
  if (!raw) return false;
  if (raw.includes(BUILTIN_CRETILI_RUNTIME_MARKER)) return true;
  if (!raw.startsWith(PREFIX)) {
    // `mcp.<server>.<tool>` and `mcp/<server>/<tool>` are foreign unless they
    // carry the builtin marker above; a plain bare name is catalog-owned.
    return !raw.includes('.') && !raw.includes('/');
  }
  const segments = raw.slice(PREFIX.length).split(/__/).filter(Boolean);
  if (segments.length < 2) return false;
  return isCretliRuntimeChain(segments.slice(0, -1));
}

/**
 * `resolveMcpBuiltinToolName` guarded by ownership: names that belong to another
 * MCP server resolve to nothing, so a gate cannot mistake their basename for a
 * builtin read tool and let it through.
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export function resolveCretliBuiltinToolName(name) {
  if (!isCretliBuiltinToolName(name)) return null;
  return resolveMcpBuiltinToolName(name);
}

/**
 * @param {string} canonicalName
 * @param {string} legacyName
 * @returns {string}
 */
export function mcpBuiltinToolDescriptionCanonicalPrefix(canonicalName, legacyName) {
  return `Canonical name: ${canonicalName} (formerly ${legacyName}). `;
}

/**
 * @param {object[]} servers
 * @param {string} runtimeName
 * @returns {object | null}
 */
export function findServerByRuntimeName(servers, runtimeName) {
  const wanted = String(runtimeName || '').trim();
  if (!wanted) return null;
  return servers.find((server) => toMcpRuntimeName(server.id) === wanted) || null;
}
