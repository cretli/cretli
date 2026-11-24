/**
 * Logo for a closed model picker: the same brand marks the sidebar shows (`/harness-icons`).
 * The model family wins when a mark exists for it (a GPT model run through OpenRouter still
 * shows the GPT mark); otherwise the harness mark is used.
 */

/** First match wins; patterns run against the lower-cased model id without `::params`. */
const FAMILY_ICONS = Object.freeze([
  { re: /claude|opus|sonnet|haiku/, file: 'claude.svg' },
  { re: /gpt|codex|(^|[^a-z])o[134](-|$)/, file: 'codex.svg' },
  { re: /deepseek/, file: 'deepseek.svg' },
  { re: /qwen|qwq/, file: 'qwen.svg' },
  { re: /mistral|codestral|mixtral/, file: 'mistral.svg' },
  { re: /mimo/, file: 'mimo.svg' },
  { re: /glm|zai/, file: 'zai.svg' },
]);

const HARNESS_ICONS = Object.freeze({
  sdk: 'cursor.svg',
  'cursor-sdk': 'cursor.svg',
  openrouter: 'openrouter.svg',
  opencode: 'opencode.svg',
  codebuddy: 'codebuddy.svg',
  deepseek: 'deepseek.svg',
  mistral: 'mistral.svg',
  zai: 'zai.svg',
  mimo: 'mimo.svg',
  antigravity: 'antigravity.svg',
  codex: 'codex.svg',
  qwen: 'qwen.svg',
  claude: 'claude.svg',
});

/**
 * @param {unknown} modelValue Stored model value (`id::params`) or bare id.
 * @param {unknown} [harness] Harness id, used when the model family has no mark.
 * @returns {string} URL of the logo
 */
export function getModelIconSrc(modelValue, harness = '') {
  const id = String(modelValue || '').toLowerCase().split('::')[0];
  const family = FAMILY_ICONS.find((row) => row.re.test(id));
  const file = family?.file || HARNESS_ICONS[String(harness || '').trim().toLowerCase()] || 'cursor.svg';
  return `/harness-icons/${file}`;
}
