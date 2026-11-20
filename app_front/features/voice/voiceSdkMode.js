/**
 * Maps a spoken or tool argument to Cretli plan/agent/ask mode.
 *
 * @param {unknown} value
 * @returns {'plan'|'agent'|'ask'|''}
 */
export function resolveVoiceSdkMode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!raw) return '';
  if (/\bask\b|\bpytan/.test(raw)) return 'ask';
  if (/\bplanowan|\bplanu\b|\bplanning\b|(^|\s)plan(\s|$)/.test(raw)) return 'plan';
  if (/\bagent|\bimplement/.test(raw)) return 'agent';
  return '';
}
