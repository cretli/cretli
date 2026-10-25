/**
 * Maps a spoken or tool argument to chat TTS read-aloud mode.
 *
 * @param {unknown} value
 * @returns {'off'|'final'|'stream'|''}
 */
export function resolveVoiceReadMode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
  if (!raw) return '';
  if (raw === 'off' || raw === 'final' || raw === 'stream') return raw;
  if (/\b(wylacz|cisza|mute|silence)\b/.test(raw)) return 'off';
  if (/\b(stream|biezaco|zdanie)\b/.test(raw)) return 'stream';
  if (/\b(final|koniec|koncu)\b/.test(raw)) return 'final';
  return '';
}
