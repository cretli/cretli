/**
 * Field classification and projection for portable settings (B2).
 *
 * `config.json` is never copied verbatim. Every top-level key is classified
 * `portable`, `definition`, `machine`, `secret` or `ignored`; anything unknown
 * is omitted as `unclassified` until it is added here. Secrets are also stripped
 * recursively by key name, so a secret nested in a portable object cannot leak.
 *
 * `definition` fields describe an executable or an external endpoint (binary
 * paths, base URLs). They are exported, but import never activates them: the
 * import stages them as pending and a separate explicit activation applies them.
 */

/** Section IDs of the portable settings document, in display order. */
export const SETTINGS_SECTION_IDS = Object.freeze([
  'general',
  'harnesses',
  'approval',
  'connections',
  'mcp',
  'workspaces',
]);

/** Sections that are machine-specific and exported only on request. */
export const MACHINE_SECTION_IDS = Object.freeze(['workspaces']);

/** @type {Record<string, string[]>} */
const PORTABLE_KEYS_BY_SECTION = {
  general: [
    'autoTitle', 'contextSettings', 'contextProfiles', 'contextPolicy', 'chatAutoArchive', 'chatRetention', 'harnessUpdateCheck', 'agentTitlePrint',
    'firstRunSetupDismissed', 'sdkRunIdleTimeoutSeconds', 'sdkRunStuckRecoveryCapSeconds',
    'sdkRunAutoRecovery', 'sdkCustomSystemPrompt', 'debugStartup', 'debugApi', 'debugTasks',
    'debugOverlay', 'debugUiFreeze', 'debugRemote', 'debugHttpTiming',
  ],
  harnesses: [
    'defaultNewChatHarness', 'enabledHarnesses', 'enabledLocalHarnesses', 'harnessOrder',
    'harnessPermissionControls', 'chatEnabledModels', 'openrouterChatEnabledModels',
    'opencodeChatEnabledModels', 'codebuddyChatEnabledModels', 'deepseekChatEnabledModels',
    'mistralChatEnabledModels', 'codexChatEnabledModels', 'qwenChatEnabledModels',
    'claudeChatEnabledModels', 'opencodeCompaction', 'deepseekCompaction', 'codexCompaction',
    'qwenContextSettings', 'codebuddyCompactInstructions', 'claudePromptCaching1h',
    'claudeAutocompactPctOverride', 'claudeDisableAutoCompact', 'zaiProvider', 'opencodeZaiProvider',
    'mistralBillingMode', 'codexAuthMode', 'qwenEndpoint', 'opencodeMaxInstances',
    'opencodeDelegationIdleMs',
  ],
  approval: ['approvalBroker'],
};

/**
 * Executable paths and endpoint URLs. Imported disabled (pending activation).
 * @type {string[]}
 */
const DEFINITION_KEYS = [
  'opencodeBin', 'codebuddyBin', 'deepseekBin', 'codexBin', 'qwenBin', 'opencodePortBase',
  'mistralBaseUrl', 'qwenBaseUrl', 'mimoBaseUrl', 'opencodeMimoBaseUrl', 'openrouterSiteUrl',
  'openrouterAppTitle',
];

/** Machine-specific keys: omitted from default exports. */
const MACHINE_KEYS = [
  'lanHost', 'workspaceFile', 'workspaceFolder', 'additionalCursorContextDirs',
  'externalMcpEnabled', 'externalMcpAllowLan',
];

/** Removed settings accepted only so stored legacy values can be silently dropped. */
const IGNORED_LEGACY_KEYS = ['frontHmrEnabled'];

/** Registry entries that belong to the optional `workspaces` section. */
const WORKSPACE_KEYS = ['workspaces', 'workspaceSidebarConfig'];

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|passwd|credential|authorization|private[-_]?key)/i;

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKeyName(key) {
  return SECRET_KEY_PATTERN.test(String(key));
}

/** Strings that look like credentials regardless of the key they sit under. */
const SECRET_VALUE_PATTERN = /^(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[bap]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeSecretValue(value) {
  return typeof value === 'string' && SECRET_VALUE_PATTERN.test(value.trim());
}

/**
 * Classification of one config.json top-level key.
 *
 * @param {string} key
 * @returns {{ class: 'portable' | 'definition' | 'machine' | 'secret' | 'ignored' | 'unclassified', section: string | null }}
 */
export function classifyConfigKey(key) {
  if (isSecretKeyName(key)) return { class: 'secret', section: null };
  for (const [section, keys] of Object.entries(PORTABLE_KEYS_BY_SECTION)) {
    if (keys.includes(key)) return { class: 'portable', section };
  }
  if (DEFINITION_KEYS.includes(key)) return { class: 'definition', section: 'connections' };
  if (WORKSPACE_KEYS.includes(key)) return { class: 'machine', section: 'workspaces' };
  if (MACHINE_KEYS.includes(key)) return { class: 'machine', section: null };
  if (IGNORED_LEGACY_KEYS.includes(key)) return { class: 'ignored', section: null };
  return { class: 'unclassified', section: null };
}

/** Keys the import may write for a portable section. */
export function portableKeysForSection(section) {
  return [...(PORTABLE_KEYS_BY_SECTION[section] || [])];
}

/** Keys of the `connections` section (staged as pending on import). */
export function definitionKeys() {
  return [...DEFINITION_KEYS];
}

/**
 * Deep-clone a JSON value with every secret-looking key and value removed.
 *
 * @param {unknown} value
 * @param {string} basePath
 * @param {Array<{ path: string, reason: string }>} omissions
 * @returns {unknown}
 */
export function stripSecretsDeep(value, basePath, omissions) {
  if (Array.isArray(value)) {
    return value.map((item, index) => stripSecretsDeep(item, `${basePath}[${index}]`, omissions));
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const childPath = basePath ? `${basePath}.${key}` : key;
      if (isSecretKeyName(key)) {
        omissions.push({ path: childPath, reason: 'secret' });
        continue;
      }
      out[key] = stripSecretsDeep(child, childPath, omissions);
    }
    return out;
  }
  return value;
}

/**
 * Remove secret-looking string values from a definition (URL credentials, tokens in query).
 *
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretKeyName(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return looksLikeSecretValue(url) ? '' : url;
  }
}

/**
 * Workspaces travel as logical identifiers only; local paths are dropped and
 * must be supplied through the import mapping table.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripWorkspacePaths(key, value) {
  if (key === 'workspaces' && Array.isArray(value)) {
    return value
      .filter((row) => row && typeof row === 'object' && typeof row.id === 'string' && row.id)
      .map((row) => ({
        id: String(row.id),
        kind: row.kind === 'file' ? 'file' : 'folders',
        ...(typeof row.label === 'string' && row.label ? { label: row.label } : {}),
      }));
  }
  if (key === 'workspaceSidebarConfig' && value && typeof value === 'object' && !Array.isArray(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [id, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== 'object') continue;
      const row = /** @type {any} */ (entry);
      out[id] = {
        ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
        ...(typeof row.label === 'string' && row.label ? { label: row.label } : {}),
      };
    }
    return out;
  }
  return value;
}

/**
 * Project `config.json` into portable sections. Secrets, machine fields and
 * unclassified keys are reported as omissions, never copied.
 *
 * @param {Record<string, unknown>} config
 * @param {{ includeMachine?: boolean }} [options]
 * @returns {{ sections: Record<string, Record<string, unknown>>, omissions: Array<{ path: string, reason: string }> }}
 */
export function projectConfigToSections(config, options = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  /** @type {Record<string, Record<string, unknown>>} */
  const sections = {};
  /** @type {Array<{ path: string, reason: string }>} */
  const omissions = [];
  for (const [key, value] of Object.entries(source)) {
    const klass = classifyConfigKey(key);
    if (klass.class === 'secret') {
      omissions.push({ path: key, reason: 'secret' });
      continue;
    }
    if (klass.class === 'unclassified') {
      omissions.push({ path: key, reason: 'unclassified' });
      continue;
    }
    if (klass.class === 'machine' && !(options.includeMachine && klass.section === 'workspaces')) {
      omissions.push({ path: key, reason: 'machine' });
      continue;
    }
    const target = klass.section;
    if (!target) continue;
    let cleaned = stripSecretsDeep(value, key, omissions);
    if (klass.section === 'workspaces') cleaned = stripWorkspacePaths(key, cleaned);
    if (klass.class === 'definition' && typeof cleaned === 'string') {
      cleaned = /^https?:\/\//i.test(cleaned) ? redactUrl(cleaned) : cleaned;
    }
    if (key === 'approvalBroker' && cleaned && typeof cleaned === 'object') {
      // The advisor endpoint is an external connection: it travels in `connections`.
      const advisor = /** @type {any} */ (cleaned).advisor;
      if (advisor && typeof advisor === 'object' && typeof advisor.baseUrl === 'string') {
        sections.connections = sections.connections || {};
        sections.connections['approvalBroker.advisor.baseUrl'] = redactUrl(advisor.baseUrl);
        delete advisor.baseUrl;
      }
    }
    sections[target] = sections[target] || {};
    sections[target][key] = cleaned;
  }
  return { sections, omissions };
}

/**
 * Re-project a section received from an imported document. The document is
 * untrusted: unknown keys, secrets and keys outside the section are dropped
 * and reported.
 *
 * @param {string} sectionId
 * @param {unknown} rawSection
 * @returns {{ values: Record<string, unknown>, rejected: Array<{ path: string, reason: string }> }}
 */
export function sanitizeImportedSection(sectionId, rawSection) {
  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Array<{ path: string, reason: string }>} */
  const rejected = [];
  if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
    return { values, rejected };
  }
  const allowed = sectionId === 'connections'
    ? new Set([...DEFINITION_KEYS, 'approvalBroker.advisor.baseUrl'])
    : sectionId === 'workspaces'
      ? new Set(WORKSPACE_KEYS)
      : new Set(PORTABLE_KEYS_BY_SECTION[sectionId] || []);
  for (const [key, value] of Object.entries(rawSection)) {
    if (IGNORED_LEGACY_KEYS.includes(key)) continue;
    if (!allowed.has(key)) {
      rejected.push({ path: key, reason: isSecretKeyName(key) ? 'secret' : 'unclassified' });
      continue;
    }
    let cleaned = stripSecretsDeep(value, key, rejected);
    if (sectionId === 'workspaces') cleaned = stripWorkspacePaths(key, cleaned);
    if (key === 'approvalBroker' && cleaned && typeof cleaned === 'object') {
      // An endpoint URL may only arrive through the `connections` section.
      const advisor = /** @type {any} */ (cleaned).advisor;
      if (advisor && typeof advisor === 'object' && 'baseUrl' in advisor) {
        delete advisor.baseUrl;
        rejected.push({ path: 'approvalBroker.advisor.baseUrl', reason: 'unclassified' });
      }
    }
    values[key] = typeof cleaned === 'string' && /^https?:\/\//i.test(cleaned) ? redactUrl(cleaned) : cleaned;
  }
  return { values, rejected };
}

/**
 * Merge an incoming object over an existing one while keeping the destination's
 * secret-looking keys. Absent incoming secrets never clear existing ones.
 *
 * @param {unknown} existing
 * @param {unknown} incoming
 * @returns {unknown}
 */
export function mergeKeepingSecrets(existing, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return incoming;
  /** @type {Record<string, unknown>} */
  const out = { ...incoming };
  for (const [key, value] of Object.entries(existing)) {
    if (isSecretKeyName(key)) {
      out[key] = value;
    } else if (key in out && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeKeepingSecrets(value, out[key]);
    }
  }
  return out;
}

/**
 * Command-line arguments that look like credentials are replaced.
 *
 * @param {string[]} args
 * @param {string} basePath
 * @param {Array<{ path: string, reason: string }>} omissions
 * @returns {string[]}
 */
export function redactArgs(args, basePath, omissions) {
  return args.map((arg, index) => {
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if ((eq > 0 && isSecretKeyName(flag)) || looksLikeSecretValue(arg)) {
      omissions.push({ path: `${basePath}[${index}]`, reason: 'secret' });
      return eq > 0 ? `${flag}=` : '';
    }
    return arg;
  });
}
