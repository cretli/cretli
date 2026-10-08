/**
 * Versioned catalog of built-in Scout templates.
 *
 * A template is only a starting point: `materializeProfileFromTemplate` returns
 * a deep, independent copy, so editing a profile (or a later version of the
 * catalog) can never mutate a stored profile or another materialized copy.
 * The catalog itself is frozen and never written to the watcher store.
 *
 * Template text is user-facing (Polish) to match the rest of the Scout UI; the
 * code and comments stay English.
 */

import { randomUUID } from 'node:crypto';
import {
  WORKSPACE_SCOUT_CATEGORIES,
  WORKSPACE_SCOUT_PROFILE_SOURCES,
  defaultWorkspaceScoutProfile,
  normalizeWorkspaceScoutProfile,
} from './persist/workspace-watchers-persist.js';

/** Bumped when the catalog shape (not a single template's text) changes. */
export const SCOUT_TEMPLATE_CATALOG_VERSION = '1';

const ALL_CATEGORIES = Object.freeze([...WORKSPACE_SCOUT_CATEGORIES]);
const ALL_SOURCES = Object.freeze([...WORKSPACE_SCOUT_PROFILE_SOURCES]);

/**
 * @param {object} template
 * @returns {object}
 */
function freezeTemplate(template) {
  return Object.freeze({
    ...template,
    scope: Object.freeze({
      mode: template.scope.mode,
      base: template.scope.base,
      include: Object.freeze([...template.scope.include]),
      exclude: Object.freeze([...template.scope.exclude]),
    }),
    sources: Object.freeze([...template.sources]),
    categories: Object.freeze([...template.categories]),
  });
}

/** @type {ReadonlyArray<object>} */
const SCOUT_TEMPLATES = Object.freeze([
  freezeTemplate({
    id: 'general',
    version: 1,
    name: 'Scout ogólny',
    description: 'Ogólny przegląd zmian pod kątem błędów, ryzyk i usprawnień.',
    objective: 'Wykrywaj błędy, ryzyka i propozycje usprawnień w całym workspace.',
    instructions: [
      'Oceń zmiany względem bazy pod kątem poprawności, bezpieczeństwa i utrzymania.',
      'Dobra propozycja: wskazuje konkretny plik i dowód (test, log, fragment kodu) oraz sposób weryfikacji.',
      'Odrzuć: kosmetykę bez wpływu, zgadywanie bez dowodu, duże przepisania.',
    ].join('\n'),
    scope: { mode: 'changes', base: 'main', include: [], exclude: [] },
    sources: [...ALL_SOURCES],
    categories: [...ALL_CATEGORIES],
  }),
  freezeTemplate({
    id: 'bugs',
    version: 1,
    name: 'Błędy i regresje',
    description: 'Szuka błędów, regresji i brakującej obsługi błędów.',
    objective: 'Znajdź błędy i regresje: czerwone testy, wyjątki, błędne warunki brzegowe.',
    instructions: [
      'Każda propozycja nazywa objaw, warunek reprodukcji i plik z wadą.',
      'Preferuj błędy potwierdzone testem, logiem albo ścieżką kodu; nie zgłaszaj stylu.',
      'Odrzuć: hipotezy bez dowodu i problemy już pokryte istniejącym TODO.',
    ].join('\n'),
    scope: { mode: 'changes', base: 'main', include: [], exclude: [] },
    sources: [...ALL_SOURCES],
    categories: ['bug', 'improvement'],
  }),
  freezeTemplate({
    id: 'security',
    version: 1,
    name: 'Bezpieczeństwo',
    description: 'Audyt sekretów, wstrzyknięć, autoryzacji i niezaufanych danych.',
    objective: 'Wykryj problemy bezpieczeństwa: sekrety w kodzie, wstrzyknięcia, brak autoryzacji.',
    instructions: [
      'Podaj wektor ataku, miejsce w kodzie i minimalny sposób potwierdzenia.',
      'Dobra propozycja: konkretna ścieżka danych od wejścia do użycia.',
      'Odrzuć: ogólne porady bez odniesienia do kodu i problemy poza zakresem.',
    ].join('\n'),
    scope: { mode: 'changes', base: 'main', include: [], exclude: [] },
    sources: ['diff', 'gitHistory', 'todoMarkers', 'logs'],
    categories: ['security'],
  }),
  freezeTemplate({
    id: 'refactor',
    version: 1,
    name: 'Refaktoryzacja',
    description: 'Dzieli zbyt duże pliki i funkcje, usuwa duplikację.',
    objective: 'Znajdź bezpieczne refaktoryzacje: zbyt duże pliki, duplikację, głębokie zagnieżdżenia.',
    instructions: [
      'Nazwij wyodrębniany szew (co i gdzie) oraz testy, które muszą pozostać zielone.',
      'Zmiana musi być zachowawcza i możliwa do przejrzenia osobno.',
      'Odrzuć: przepisania, nowe zależności i zmiany wyłącznie stylistyczne.',
    ].join('\n'),
    scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
    sources: ['diff', 'gitHistory', 'todoMarkers'],
    categories: ['refactor'],
  }),
  freezeTemplate({
    id: 'docs',
    version: 1,
    name: 'Dokumentacja',
    description: 'Uzupełnia brakującą dokumentację i aktualizuje opisy po zmianach.',
    objective: 'Znajdź brakującą lub nieaktualną dokumentację względem kodu.',
    instructions: [
      'Wskaż plik kodu i miejsce w dokumentacji, które trzeba uzupełnić.',
      'Dobra propozycja: konkretna sekcja i brakujący fakt, nie „dodać dokumentację”.',
      'Odrzuć: ogólne uwagi o stylu dokumentacji.',
    ].join('\n'),
    scope: { mode: 'area', base: 'main', include: ['**/*.md', 'docs/**'], exclude: [] },
    sources: ['diff', 'gitHistory', 'todoMarkers'],
    categories: ['documentation'],
  }),
  freezeTemplate({
    id: 'performance',
    version: 1,
    name: 'Wydajność',
    description: 'Szuka zapytań N+1, brakujących indeksów i kosztownych ścieżek.',
    objective: 'Znajdź problemy wydajnościowe: N+1, brakujące indeksy, zbędna praca w pętli.',
    instructions: [
      'Każda propozycja wskazuje zapytanie/ścieżkę kodu oraz sposób pomiaru.',
      'Dobra propozycja: oczekiwany zysk i metryka, którą da się porównać.',
      'Odrzuć: mikro-optymalizacje bez mierzalnego wpływu.',
    ].join('\n'),
    scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
    sources: ['diff', 'gitHistory', 'todoMarkers', 'testResults', 'logs'],
    categories: ['opportunity', 'bug'],
  }),
]);

/** @type {Map<string, object>} */
const TEMPLATES_BY_ID = new Map(SCOUT_TEMPLATES.map((template) => [template.id, template]));

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * @returns {string[]}
 */
export function listScoutTemplateIds() {
  return SCOUT_TEMPLATES.map((template) => template.id);
}

/**
 * Deep, independent copy of a template. Callers may freely mutate the result.
 *
 * @param {object} template
 * @returns {object | null}
 */
export function cloneScoutTemplate(template) {
  if (!template || typeof template !== 'object') return null;
  return {
    id: asString(template.id),
    version: Number(template.version) || 1,
    name: asString(template.name),
    description: asString(template.description),
    objective: asString(template.objective),
    instructions: asString(template.instructions),
    scope: {
      mode: asString(template.scope?.mode) || 'changes',
      base: asString(template.scope?.base) || 'main',
      include: [...(Array.isArray(template.scope?.include) ? template.scope.include : [])],
      exclude: [...(Array.isArray(template.scope?.exclude) ? template.scope.exclude : [])],
    },
    sources: [...(Array.isArray(template.sources) ? template.sources : [])],
    categories: [...(Array.isArray(template.categories) ? template.categories : [])],
  };
}

/**
 * List the catalog. Returns deep copies so a caller can never mutate the
 * catalog (and therefore never another profile's source).
 *
 * @returns {object[]}
 */
export function listScoutTemplates() {
  return SCOUT_TEMPLATES.map((template) => cloneScoutTemplate(template));
}

/**
 * @param {unknown} templateId
 * @returns {object | null}
 */
export function getScoutTemplate(templateId) {
  const id = asString(templateId);
  if (!id) return null;
  const template = TEMPLATES_BY_ID.get(id);
  return template ? cloneScoutTemplate(template) : null;
}

/**
 * Build a fresh, normalized profile from a template. The profile is an
 * independent deep copy of the template's task definition: a later template
 * update never reaches it, and editing it never reaches the template.
 *
 * A new profile is always `enabled: false` with a manual schedule, matching
 * the product rule that a user opts into automatic scans explicitly.
 *
 * @param {unknown} templateId
 * @param {object} [overrides] profile fields that win over the template
 * @returns {object | null} normalized profile, or null for an unknown template
 */
export function materializeProfileFromTemplate(templateId, overrides = {}) {
  const template = getScoutTemplate(templateId);
  if (!template) return null;
  const base = defaultWorkspaceScoutProfile();
  const explicit = overrides && typeof overrides === 'object' ? overrides : {};
  const profile = {
    ...base,
    id: asString(explicit.id) || randomUUID(),
    revision: 1,
    name: template.name,
    description: template.description,
    objective: template.objective,
    instructions: template.instructions,
    scope: template.scope,
    sources: template.sources,
    categories: template.categories,
    templateId: template.id,
    templateVersion: String(template.version),
    // Templates never opt a profile into automation or a schedule by themselves.
    enabled: false,
    schedule: { mode: 'manual', intervalHours: base.schedule.intervalHours },
    ...explicit,
  };
  return normalizeWorkspaceScoutProfile(profile, { now: 0 });
}

/**
 * Truncated one-line representation of a value for a diff summary.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function diffValue(value, max = 240) {
  const text = Array.isArray(value) || (value && typeof value === 'object')
    ? JSON.stringify(value)
    : asString(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Human-readable diff between a stored profile and the current template task
 * definition. Only the fields `restoreProfileInstructionsFromTemplate` would
 * overwrite are compared.
 *
 * @param {object} current normalized profile
 * @param {object} template
 * @returns {Array<{ field: string, before: string, after: string }>}
 */
export function diffProfileAgainstTemplate(current, template) {
  const fields = [
    ['name', 'name'],
    ['description', 'description'],
    ['objective', 'objective'],
    ['instructions', 'instructions'],
    ['scope', 'scope'],
    ['sources', 'sources'],
    ['categories', 'categories'],
  ];
  /** @type {Array<{ field: string, before: string, after: string }>} */
  const diff = [];
  for (const [field, key] of fields) {
    const before = diffValue(current?.[key]);
    const after = diffValue(template?.[key]);
    if (before !== after) diff.push({ field, before, after });
  }
  return diff;
}

/**
 * Restore the template-owned task definition (name, description, objective,
 * instructions, scope, sources, categories) onto a profile copy. Identity,
 * revision, enablement, archive state, executor, schedule, limits and
 * timestamps are preserved.
 *
 * Never mutates `profile` or the catalog. Returns a diff summary so the caller
 * (API/UI) can show what the restore would change before applying it.
 *
 * @param {object} profile
 * @param {{ templateId?: string }} [options]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   profile: object,
 *   diff: Array<{ field: string, before: string, after: string }>,
 *   templateId: string,
 *   templateVersion: string,
 * }}
 */
export function restoreProfileInstructionsFromTemplate(profile, options = {}) {
  const current = profile && typeof profile === 'object' ? profile : {};
  const templateId = asString(options.templateId) || asString(current.templateId);
  const template = getScoutTemplate(templateId);
  if (!template) {
    return {
      ok: false,
      reason: 'template_not_found',
      profile: structuredCloneSafe(current),
      diff: [],
      templateId,
      templateVersion: '',
    };
  }
  const diff = diffProfileAgainstTemplate(current, template);
  const restored = normalizeWorkspaceScoutProfile({
    ...structuredCloneSafe(current),
    name: template.name,
    description: template.description,
    objective: template.objective,
    instructions: template.instructions,
    scope: template.scope,
    sources: template.sources,
    categories: template.categories,
    templateId: template.id,
    templateVersion: String(template.version),
  });
  return {
    ok: true,
    profile: restored,
    diff,
    templateId: template.id,
    templateVersion: String(template.version),
  };
}

/**
 * Deep clone without sharing nested references. `structuredClone` exists on the
 * supported Node versions; a JSON fallback keeps this safe on older runtimes.
 *
 * @param {unknown} value
 * @returns {any}
 */
function structuredCloneSafe(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fall through to JSON
    }
  }
  return JSON.parse(JSON.stringify(value));
}
