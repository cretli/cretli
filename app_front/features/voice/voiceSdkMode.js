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
  if (/\bplanowan|\bplanu\b|\bplanning\b|(^|\s)plan(\s|$)/.test(raw)) return 'plan';
  if (/\bagent|\bimplement/.test(raw)) return 'agent';
  return '';
}
