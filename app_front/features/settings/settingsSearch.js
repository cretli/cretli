import { SETTINGS_CATEGORIES, settingsCategoryForTab } from './settingsCategories.js';

export function normalizeSettingsSearch(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().trim();
}

/** Records contain labels only; never pass input values or rendered panel HTML. */
export function buildSettingsSearchIndex(categories, labels, translate) {
  return [
    ...categories.map(c => ({ category: c.id, tab: c.id, label: translate(c.labelKey), keywords: c.keywords })),
    ...labels.flatMap(record => {
      const category = settingsCategoryForTab(record.tab);
      return category && record.label.trim() ? [{ ...record, category: category.id, keywords: '' }] : [];
    }),
  ].map(record => ({ ...record, searchText: normalizeSettingsSearch(`${record.label} ${record.keywords}`) }));
}

export function filterSettingsSearch(index, query) {
  const terms = normalizeSettingsSearch(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return index.filter(record => terms.every(term => record.searchText.includes(term)));
}

export { SETTINGS_CATEGORIES };
