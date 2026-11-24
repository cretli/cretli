/**
 * Claude Code permission profiles Cretli can write into a folder's
 * `.claude/settings.local.json` when it connects Claude Code (Settings → MCP →
 * Connect, Remote Control operator chats).
 *
 * Pure data and functions with no node imports, so the browser UI can import
 * the same constant it describes to the user. Claude Code evaluates `deny`,
 * then `ask`, then `allow`: `Bash` in `allow` plus the `ask` patterns means
 * "prompt for these, allow the rest".
 */

/** Claude Code permission rule that allows every tool of the Cretli MCP server. */
export const CLAUDE_TOOL_PERMISSION_RULE = 'mcp__cretli';
/** The only `permissions.defaultMode` value Cretli ever sets. */
export const CLAUDE_OWNED_DEFAULT_MODE = 'acceptEdits';
/** Rule lists of `permissions` that profiles manage. */
export const CLAUDE_RULE_LISTS = Object.freeze(['allow', 'ask', 'deny']);

/**
 * @typedef {'prompt' | 'cretli_tools' | 'edits_bash_guarded'} ClaudePermissionProfileName
 * @typedef {{ allow: string[], ask: string[], deny: string[] }} ClaudeRuleSet
 * @typedef {{ owned: boolean, previous: string | null }} ClaudeDefaultModeOwnership
 * @typedef {{ profile: ClaudePermissionProfileName, addedRules: ClaudeRuleSet, defaultMode: ClaudeDefaultModeOwnership }} ClaudePermissionGrant
 */

/** Profiles from the weakest to the strongest; each one requires a superset of the previous one. */
export const PROFILE_ORDER = Object.freeze(['prompt', 'cretli_tools', 'edits_bash_guarded']);

/** @type {Readonly<Record<string, { allow: readonly string[], ask: readonly string[], deny: readonly string[], defaultMode?: string }>>} */
export const CLAUDE_PERMISSION_PROFILES = Object.freeze({
  prompt: Object.freeze({ allow: Object.freeze([]), ask: Object.freeze([]), deny: Object.freeze([]) }),
  cretli_tools: Object.freeze({ allow: Object.freeze([CLAUDE_TOOL_PERMISSION_RULE]), ask: Object.freeze([]), deny: Object.freeze([]) }),
  edits_bash_guarded: Object.freeze({
    defaultMode: CLAUDE_OWNED_DEFAULT_MODE,
    allow: Object.freeze([CLAUDE_TOOL_PERMISSION_RULE, 'Bash', 'Edit', 'Write', 'Read']),
    ask: Object.freeze([
      'Bash(git push)',
      'Bash(git push *)',
      'Bash(rm -rf *)',
      'Bash(rm -fr *)',
      'Bash(git reset --hard *)',
      'Bash(git clean *)',
      'Bash(*task-restart-server.sh*)',
      'Bash(sudo *)',
    ]),
    deny: Object.freeze(['Read(./.env)', 'Read(./.env.*)']),
  }),
});

/** @returns {ClaudeRuleSet} */
export function emptyRuleSet() {
  return { allow: [], ask: [], deny: [] };
}

/** @returns {ClaudePermissionGrant} A grant that owns nothing (profile `prompt`). */
export function emptyGrant() {
  return { profile: 'prompt', addedRules: emptyRuleSet(), defaultMode: { owned: false, previous: null } };
}

/**
 * The strongest of the given profile names (unknown names count as `prompt`).
 *
 * @param {Iterable<string>} names
 * @returns {ClaudePermissionProfileName}
 */
export function strongestProfile(names) {
  let best = 0;
  for (const name of names) best = Math.max(best, Math.max(0, PROFILE_ORDER.indexOf(name)));
  return /** @type {ClaudePermissionProfileName} */ (PROFILE_ORDER[best]);
}

/**
 * Validate the profile of a request.
 *
 * @param {unknown} value `permissionProfile` as sent by the caller
 * @param {{ allowTools?: unknown }} [legacy] older `allowTools` boolean
 * @returns {{ profile: ClaudePermissionProfileName | undefined } | { error: string }}
 */
export function normalizePermissionProfile(value, legacy = {}) {
  if (value !== undefined && value !== null && value !== '') {
    if (typeof value === 'string' && PROFILE_ORDER.includes(value)) {
      return { profile: /** @type {ClaudePermissionProfileName} */ (value) };
    }
    return { error: `permissionProfile must be one of: ${PROFILE_ORDER.join(', ')}` };
  }
  if (legacy.allowTools === true) return { profile: 'cretli_tools' };
  if (legacy.allowTools === false) return { profile: 'prompt' };
  return { profile: undefined };
}

/**
 * What a profile needs to be in the settings file.
 *
 * @param {string} profile
 * @returns {{ allow: readonly string[], ask: readonly string[], deny: readonly string[], defaultMode?: string }}
 */
export function profileRequires(profile) {
  return CLAUDE_PERMISSION_PROFILES[profile] || CLAUDE_PERMISSION_PROFILES.prompt;
}

/**
 * The grant recorded on a client row. Rows written before profiles existed
 * carry `claudeToolPermission: 'added' | 'existing'`; both read as
 * `cretli_tools`, `added` owning the rule.
 *
 * @param {Record<string, any> | null | undefined} row
 * @returns {ClaudePermissionGrant}
 */
export function effectiveGrant(row) {
  const stored = row?.claudePermissionGrant;
  if (stored && typeof stored === 'object') {
    const profile = PROFILE_ORDER.includes(stored.profile) ? stored.profile : 'prompt';
    const rules = emptyRuleSet();
    for (const list of CLAUDE_RULE_LISTS) {
      const key = /** @type {'allow' | 'ask' | 'deny'} */ (list);
      if (Array.isArray(stored.addedRules?.[key])) rules[key] = stored.addedRules[key].filter((rule) => typeof rule === 'string');
    }
    return {
      profile,
      addedRules: rules,
      defaultMode: { owned: stored.defaultMode?.owned === true, previous: typeof stored.defaultMode?.previous === 'string' ? stored.defaultMode.previous : null },
    };
  }
  if (row?.claudeToolPermission === 'added' || row?.claudeToolPermission === 'existing') {
    const grant = emptyGrant();
    grant.profile = 'cretli_tools';
    if (row.claudeToolPermission === 'added') grant.addedRules.allow.push(CLAUDE_TOOL_PERMISSION_RULE);
    return grant;
  }
  return emptyGrant();
}

/**
 * Merge the grants of clients that are being replaced: rules per-list union,
 * `defaultMode` owned when any grant owns it (the first one in the given
 * order, which callers sort by creation time, supplies `previous`), profile
 * the strongest of them.
 *
 * @param {ClaudePermissionGrant[]} grants
 * @returns {ClaudePermissionGrant}
 */
export function mergeGrants(grants) {
  const merged = emptyGrant();
  merged.profile = strongestProfile(grants.map((grant) => grant.profile));
  for (const grant of grants) {
    for (const list of CLAUDE_RULE_LISTS) {
      const key = /** @type {'allow' | 'ask' | 'deny'} */ (list);
      for (const rule of grant.addedRules[key]) if (!merged.addedRules[key].includes(rule)) merged.addedRules[key].push(rule);
    }
    if (grant.defaultMode.owned && !merged.defaultMode.owned) merged.defaultMode = { owned: true, previous: grant.defaultMode.previous };
  }
  return merged;
}
