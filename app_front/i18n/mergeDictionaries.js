/**
 * Merges i18n fragments into one nested dictionary. Packs shipped by a harness
 * add keys; they may extend a section of the base dictionary but never replace
 * an existing string, so a colliding key is reported instead of silently winning.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isSection(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @param {string} path
 */
function mergeInto(target, source, path) {
  for (const [key, value] of Object.entries(source)) {
    const here = path ? `${path}.${key}` : key;
    const existing = target[key];
    if (isSection(value)) {
      if (existing !== undefined && !isSection(existing)) throw new Error(`[i18n] pack key ${here} collides with a string`);
      const section = isSection(existing) ? existing : {};
      target[key] = section;
      mergeInto(section, value, here);
      continue;
    }
    if (existing !== undefined) throw new Error(`[i18n] duplicate key ${here}`);
    target[key] = value;
  }
}

/**
 * @param {Record<string, unknown>} base
 * @param {...Record<string, unknown>} packs
 * @returns {Record<string, any>} A new dictionary; the inputs are not modified.
 */
export function mergeDictionaries(base, ...packs) {
  /** @type {Record<string, unknown>} */
  const merged = {};
  mergeInto(merged, base, '');
  for (const pack of packs) mergeInto(merged, pack, '');
  return merged;
}
