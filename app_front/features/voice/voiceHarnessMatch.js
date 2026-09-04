/**
 * Maps a spoken or tool argument to a coding-agent harness id.
 * Unknown values stay empty — unlike normalizeAgentTransport, which maps them to sdk.
 *
 * @param {unknown} value
 * @returns {'sdk'|'openrouter'|'opencode'|'codebuddy'|'deepseek'|'codex'|'qwen'|''}
 */
export function resolveVoiceHarness(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
  if (!raw) return '';
  if (/\bopen\s*router\b/.test(raw) || /\bopenrouter\b/.test(raw)) return 'openrouter';
  if (/\bopen\s*code\b/.test(raw) || /\bopencode\b/.test(raw)) return 'opencode';
  if (/\bcode\s*buddy\b/.test(raw) || /\bcodebuddy\b/.test(raw)) return 'codebuddy';
  if (/\bdeep\s*seek\b/.test(raw) || /\bdeepseek\b/.test(raw)) return 'deepseek';
  if (/\bcodex\b/.test(raw)) return 'codex';
  if (/\bqwen\b/.test(raw) || /\bkwen\b/.test(raw)) return 'qwen';
  if (/\bcursor\b/.test(raw) || /\bkursor\b/.test(raw) || /(^|\s)sdk(\s|$)/.test(raw)) return 'sdk';
  return '';
}
