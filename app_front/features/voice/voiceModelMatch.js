/**
 * Resolves a spoken model name against the enabled models of the active harness.
 */

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeSpoken(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
}

/**
 * Collapses spoken variants ("grok 4.6", "grok-4.6") onto one comparable key.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeModelKey(text) {
  return normalizeSpoken(text)
    .replace(/::.*$/, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * @param {{ id?: string, value?: string, label?: string }} model
 * @returns {string}
 */
function modelSpokenId(model) {
  return String(model?.id || model?.value || '').trim();
}

/**
 * @param {{ id?: string, value?: string, label?: string }} model
 * @returns {string[]}
 */
function modelMatchLabels(model) {
  return [modelSpokenId(model), model?.label]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

/**
 * @param {Array<{ id?: string, value?: string, label?: string }>} models
 * @param {string} spoken
 * @returns {{ match?: object|null, ambiguous?: boolean, candidates?: string[] }}
 */
/**
 * @param {string} label
 * @returns {string}
 */
function spokenModelKey(label) {
  return normalizeModelKey(label);
}

export function matchModelBySpokenName(models, spoken) {
  const needle = normalizeSpoken(spoken);
  const needleKey = normalizeModelKey(spoken);
  if (!needle) return { match: null };
  const items = Array.isArray(models)
    ? models.filter((model) => modelSpokenId(model))
    : [];
  const exact = items.filter((model) =>
    modelMatchLabels(model).some((label) => {
      const normalized = normalizeSpoken(label);
      return normalized === needle || spokenModelKey(label) === needleKey;
    })
  );
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) {
    return { ambiguous: true, candidates: exact.map((model) => modelSpokenId(model)) };
  }
  const partial = items.filter((model) =>
    modelMatchLabels(model).some((label) => {
      const value = normalizeSpoken(label);
      const valueKey = spokenModelKey(label);
      if (needleKey.length >= 3 && valueKey.includes(needleKey)) return true;
      if (valueKey.length >= 4 && needleKey.includes(valueKey)) return true;
      if (needle.length >= 2 && value.includes(needle)) return true;
      if (value.length >= 4 && needle.includes(value)) return true;
      return false;
    })
  );
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) {
    return {
      ambiguous: true,
      candidates: partial.slice(0, 12).map((model) => modelSpokenId(model)),
    };
  }
  return { match: null };
}
