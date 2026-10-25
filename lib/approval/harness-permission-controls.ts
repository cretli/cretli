/** Human-configured approval categories. Read-only mode guards remain independent. */
export const PERMISSION_HARNESS_LABELS = Object.freeze({ sdk: 'Cursor SDK', openrouter: 'OpenRouter', opencode: 'OpenCode', codebuddy: 'CodeBuddy', deepseek: 'DeepSeek', mistral: 'Mistral', zai: 'Z.AI SDK', mimo: 'MiMo', qwen: 'Qwen', claude: 'Claude', codex: 'Codex' });
export const PERMISSION_CONTROL_HARNESSES = Object.freeze(Object.keys(PERMISSION_HARNESS_LABELS));
export const HOSTED_PERMISSION_HARNESSES = Object.freeze(['openrouter', 'mistral', 'zai', 'mimo']);
export const GATED_PERMISSION_HARNESSES = Object.freeze(['claude', 'qwen', 'opencode', ...HOSTED_PERMISSION_HARNESSES]);
export const PERMISSION_CONTROL_CATEGORIES = Object.freeze(['files', 'mcp', 'shell', 'web', 'other']);

/** Missing and malformed values keep approval checks enabled. */
export type HarnessPermissionControls = Record<string, Record<string, boolean>>;

type ControlsInput = Record<string, Record<string, unknown> | undefined> | null | undefined;

export function normalizeHarnessPermissionControls(value: unknown): HarnessPermissionControls {
  const input = value as ControlsInput;
  return Object.fromEntries(PERMISSION_CONTROL_HARNESSES.map((harness) => [harness,
    Object.fromEntries(['enabled', ...PERMISSION_CONTROL_CATEGORIES].map((key) => [key, input?.[harness]?.[key] !== false])),
  ]));
}

/** Merge booleans only, preserving the settings for other harnesses. */
export function patchHarnessPermissionControls(current: unknown, patch: unknown): HarnessPermissionControls {
  const patchInput = patch as ControlsInput;
  const result = normalizeHarnessPermissionControls(current);
  for (const harness of PERMISSION_CONTROL_HARNESSES) {
    for (const key of ['enabled', ...PERMISSION_CONTROL_CATEGORIES]) {
      if (typeof patchInput?.[harness]?.[key] === 'boolean') result[harness][key] = patchInput![harness]![key] as boolean;
    }
  }
  return result;
}

/** Classify the tool itself; MCP arguments cannot disguise it as a file read. */
export function getPermissionControlCategory(toolName: unknown): string {
  const name = String(toolName || '').trim().toLowerCase();
  if (/^(mcp(?:$|[._/])|cretli_)/.test(name)) return 'mcp';
  if (['bash', 'shell', 'run_shell_command', 'run_terminal_command', 'execute', 'exec', 'terminal'].includes(name) || name.startsWith('shell.')) return 'shell';
  if (['webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch', 'search_web'].includes(name)) return 'web';
  if (['read', 'read file', 'read_file', 'readfile', 'write', 'write_file', 'writefile', 'edit', 'edit_file', 'search_replace', 'multiedit', 'notebookedit', 'glob', 'grep', 'ls', 'list_directory', 'external_directory', 'apply_patch', 'delete', 'delete_file'].includes(name)) return 'files';
  return 'other';
}

/** Explicit user opt-out applies only to a supported harness and category. */
export function isHarnessPermissionControlDisabled(settings: { harnessPermissionControls?: unknown } | null | undefined, harness: string, toolName: unknown): boolean {
  if (!PERMISSION_CONTROL_HARNESSES.includes(harness)) return false;
  const controls = normalizeHarnessPermissionControls(settings?.harnessPermissionControls)[harness];
  return !controls.enabled || !controls[getPermissionControlCategory(toolName)];
}
