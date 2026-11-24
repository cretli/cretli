/** Pure helpers for the delegation card header (model, effort, elapsed clock). */

/**
 * Split a stored model value (`id::effort=low`) into the display name and effort.
 *
 * @param {unknown} value
 * @returns {{ name: string, effort: string }}
 */
export function parseExecutorModel(value) {
  const raw = String(value || '').trim();
  const [name, ...params] = raw.split('::');
  let effort = '';
  for (const part of params.join('::').split(/[;,&]/)) {
    const m = /^\s*effort\s*=\s*([\w-]+)\s*$/i.exec(part);
    if (m) effort = m[1].toLowerCase();
  }
  return { name: name.trim(), effort };
}

/**
 * @param {number} ms
 * @returns {string} `m:ss` or `h:mm:ss`
 */
export function formatElapsedClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
