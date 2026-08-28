/**
 * Maps a spoken or tool argument to Cretli plan/agent mode.
 *
 * @param {unknown} value
 * @returns {'plan'|'agent'|''}
 */
export function resolveVoiceSdkMode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!raw) return '';
  if (raw === 'plan' || /(^|\s)plan(\s|$)/.test(raw)) return 'plan';
  if (raw === 'agent' || /(^|\s)agent/.test(raw)) return 'agent';
  return '';
}
