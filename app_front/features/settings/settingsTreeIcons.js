/** Icons for the settings tree: harness logos for providers, MDI glyph classes elsewhere. */

const HARNESS_LOGOS = Object.freeze({
  sdk: 'cursor.svg',
  openrouter: 'openrouter.svg',
  opencode: 'opencode.svg',
  codebuddy: 'codebuddy.svg',
  deepseek: 'deepseek.svg',
  mistral: 'mistral.svg',
  zai: 'zai.svg',
  mimo: 'mimo.svg',
  qwen: 'qwen.svg',
  claude: 'claude.svg',
  codex: 'codex.svg',
  antigravity: 'antigravity.svg',
});

/** Last id segment -> MDI class. */
const SEGMENT_ICONS = Object.freeze({
  overview: 'mdi-view-dashboard-outline',
  general: 'mdi-tune-variant',
  plugins: 'mdi-puzzle-outline',
  diagnostics: 'mdi-stethoscope',
  roles: 'mdi-account-group-outline',
  statistics: 'mdi-chart-bar',
  sources: 'mdi-database-outline',
  keys: 'mdi-key-outline',
  models: 'mdi-cube-outline',
  approvals: 'mdi-shield-check-outline',
  stats: 'mdi-chart-line',
  titles: 'mdi-format-title',
  archive: 'mdi-archive-outline',
  uploads: 'mdi-upload-outline',
  recovery: 'mdi-backup-restore',
  limits: 'mdi-speedometer',
  review: 'mdi-clipboard-check-outline',
  sessions: 'mdi-history',
  lessons: 'mdi-school-outline',
  prompts: 'mdi-text-box-outline',
  certificates: 'mdi-certificate-outline',
  network: 'mdi-lan',
  clients: 'mdi-account-network-outline',
  operator: 'mdi-account-cog-outline',
  playbook: 'mdi-book-open-variant',
  proposals: 'mdi-lightbulb-outline',
  activity: 'mdi-pulse',
  monitor: 'mdi-eye-outline',
  settings: 'mdi-cog-outline',
  scout: 'mdi-radar',
  actions: 'mdi-flash-outline',
  notifications: 'mdi-bell-outline',
  terminal: 'mdi-console',
  voice: 'mdi-microphone-outline',
  browser: 'mdi-web',
  storage: 'mdi-database-outline',
});

/**
 * @param {{ id: string, icon?: string }} node
 * @returns {{ kind: 'img', src: string } | { kind: 'mdi', cls: string } | null}
 */
export function resolveSettingsNodeIcon(node) {
  if (node.icon) return { kind: 'mdi', cls: node.icon };
  const provider = /^harness-([a-z]+)$/.exec(node.id)?.[1];
  if (provider && HARNESS_LOGOS[provider]) return { kind: 'img', src: `/harness-icons/${HARNESS_LOGOS[provider]}` };
  const segment = node.id.split('-').pop() || '';
  const cls = SEGMENT_ICONS[segment];
  return cls ? { kind: 'mdi', cls } : { kind: 'mdi', cls: 'mdi-circle-small' };
}
