/**
 * Maps a spoken or tool argument to a terminal navigation key.
 *
 * @param {unknown} value
 * @returns {'up'|'down'|'left'|'right'|'enter'|'escape'|'y'|'n'|''}
 */
export function resolveVoiceNavKey(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
  if (!raw) return '';
  if (raw === 'y' || raw === 'n') return raw;
  if (/\b(tak|yes)\b/.test(raw)) return 'y';
  if (/\b(nie|no)\b/.test(raw)) return 'n';
  if (/\b(enter|return|zatwierdz|potwierdz)\b/.test(raw)) return 'enter';
  if (/\b(escape|esc|anuluj)\b/.test(raw)) return 'escape';
  if (/\b(up|gora|gore)\b/.test(raw)) return 'up';
  if (/\b(down|dol|dolu)\b/.test(raw)) return 'down';
  if (/\b(left|lewo|lewa)\b/.test(raw)) return 'left';
  if (/\b(right|prawo|prawa)\b/.test(raw)) return 'right';
  return '';
}
