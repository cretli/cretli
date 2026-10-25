/**
 * Explicit skill activation.
 *
 * A skill's full instructions reach the model only when the user (or a caller
 * acting for them) picked it explicitly:
 *
 * 1. structured IDs (picker or an explicit chat list, `selectedSkillIds`);
 * 2. an unquoted `@name` in the CURRENT user message, when the caller says the
 *    text is user-authored (`parseMentions`).
 *
 * Plain mentions of a name, quotes, code, logs, plans, reports, handoff text and
 * delegation task text never activate a skill. The old "name next to a verb"
 * keyword heuristic survives only as `isSkillSelectedLegacy`, used by the
 * rollback switch (`CRETLI_SKILL_SELECTION=legacy`) and by the difference
 * diagnostics that show what the old rule would have activated.
 *
 * Commands and agents are listed by the picker, but nothing here activates
 * them: a selected command/agent ID yields a `kind_not_activatable` diagnostic
 * because Cretli cannot promise command execution a harness may not have.
 */

export const SKILL_SELECTION_MODES = Object.freeze(['explicit', 'legacy']);
export const MAX_SELECTED_SKILL_IDS = 32;
const MAX_SKILL_ID_LENGTH = 512;

/**
 * `explicit` (default) or `legacy` (rollback to the keyword heuristic).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'explicit' | 'legacy'}
 */
export function resolveSkillSelectionMode(env = process.env) {
  return String(env.CRETLI_SKILL_SELECTION || '').trim().toLowerCase() === 'legacy' ? 'legacy' : 'explicit';
}

/**
 * @typedef {Object} SkillSelection
 * @property {string[]} skillIds Explicit registry IDs.
 * @property {boolean} parseMentions The prompt is user-authored: honour unquoted `@name`.
 */

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) < 32) return true;
  return false;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeSkillIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || id.length > MAX_SKILL_ID_LENGTH || hasControlChar(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_SELECTED_SKILL_IDS) break;
  }
  return ids;
}

/**
 * Accepts an ID array, a selection object or nothing.
 *
 * @param {unknown} raw
 * @returns {SkillSelection}
 */
export function normalizeSkillSelection(raw) {
  if (Array.isArray(raw)) return { skillIds: normalizeSkillIds(raw), parseMentions: false };
  if (raw && typeof raw === 'object') {
    const source = /** @type {Record<string, any>} */ (raw);
    return {
      skillIds: normalizeSkillIds(source.skillIds ?? source.selectedSkillIds),
      parseMentions: source.parseMentions === true,
    };
  }
  return { skillIds: [], parseMentions: false };
}

/**
 * Selection of a server-started run (queue, watcher, delegation): explicit IDs
 * only. The prompt of such a run is never user-authored text, so no `@name` in it
 * activates anything.
 *
 * @param {unknown} ids
 * @returns {SkillSelection}
 */
export function selectionFromSkillIds(ids) {
  return { skillIds: normalizeSkillIds(ids), parseMentions: false };
}

/**
 * Selection carried by a client WebSocket message. The text of a client message
 * is user-authored, so mentions are honoured unless the client opts out
 * (`skillMentions: false`, e.g. for a pasted handoff).
 *
 * @param {unknown} msg
 * @returns {SkillSelection}
 */
export function readClientSkillSelection(msg) {
  const source = msg && typeof msg === 'object' ? /** @type {Record<string, any>} */ (msg) : {};
  return {
    skillIds: normalizeSkillIds(source.selectedSkillIds),
    parseMentions: source.skillMentions !== false,
  };
}

/**
 * Store a selection on a queue item so it survives queueing, retry and drain.
 * Nothing is stored when the selection carries no IDs and no mention policy.
 *
 * @param {Record<string, any>} item
 * @param {unknown} selection
 * @returns {Record<string, any>}
 */
export function withSkillSelection(item, selection) {
  const normalized = normalizeSkillSelection(selection);
  if (normalized.skillIds.length > 0 || normalized.parseMentions) item.selection = normalized;
  return item;
}

/**
 * Remember the selection of the run that starts now, so every prompt decoration
 * of that run (also a later retry in the same run) uses it.
 *
 * @param {Record<string, any>} room
 * @param {unknown} selection
 * @returns {SkillSelection}
 */
export function setActiveSelection(room, selection) {
  const normalized = normalizeSkillSelection(selection);
  room._activeSelection = normalized;
  return normalized;
}

/**
 * True when the message asks for a skill: explicit IDs, or an active `@name`.
 * Such a message must go through the full prompt builder, so it cannot be
 * delivered as a raw mid-run steer.
 *
 * @param {string} text
 * @param {unknown} selection
 * @returns {boolean}
 */
export function selectionRequestsSkill(text, selection) {
  const normalized = normalizeSkillSelection(selection);
  if (normalized.skillIds.length > 0) return true;
  return normalized.parseMentions && extractActiveMentions(String(text || '')).length > 0;
}

/**
 * @param {SkillSelection | null | undefined} selection
 * @returns {boolean}
 */
export function hasSkillSelectionInput(selection) {
  return Boolean(selection && selection.skillIds.length > 0);
}

/**
 * Remove the parts of a message that can never activate a skill: fenced and
 * inline code, indented code, blockquotes, double-quoted spans and log lines.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripNonActivatingText(text) {
  let out = String(text || '');
  out = out.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '$1');
  out = out.replace(/`[^`\n]*`/g, ' ');
  out = out
    .split('\n')
    .filter((line) => !/^\s*>/.test(line)
      && !/^( {4}|\t)\S/.test(line)
      && !/^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(line)
      && !/^\s*\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?[:\s]/.test(line))
    .join('\n');
  out = out.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, ' ');
  return out;
}

/**
 * Names written as an unquoted `@name` in a user message.
 *
 * @param {string} text
 * @returns {string[]} Lower-cased, unique, in order of appearance.
 */
export function extractActiveMentions(text) {
  const cleaned = stripNonActivatingText(text);
  const names = [];
  const pattern = /(^|[\s([{,;:])@([a-z0-9][a-z0-9._-]*)/gi;
  for (const match of cleaned.matchAll(pattern)) {
    const name = match[2].replace(/[._-]+$/, '').toLowerCase();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The previous keyword rule: `@name`, or a bare name right next to a verb or
 * the word "skill". Kept for the rollback switch and for diagnostics only.
 *
 * @param {string} prompt
 * @param {string} name
 * @returns {boolean}
 */
export function isSkillSelectedLegacy(prompt, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`(?:^|[^a-z0-9._-])(@${escapedName}|${escapedName})(?![a-z0-9._-])`, 'ig');
  for (const match of String(prompt || '').matchAll(mention)) {
    if (match[1].startsWith('@')) return true;
    const nameStart = match.index + match[0].length - match[1].length;
    const before = prompt.slice(Math.max(0, nameStart - 24), nameStart);
    const after = prompt.slice(match.index + match[0].length, match.index + match[0].length + 12);
    if (/\b(skill|run|use|invoke|load)\s+(the\s+)?["'`]?$/i.test(before) || /^["'`]?\s+skill\b/i.test(after)) return true;
  }
  return false;
}

/**
 * @typedef {Object} SkillCandidate
 * @property {string} id Registry ID, empty for a scanner-only entry.
 * @property {string} name Call name.
 * @property {() => string} readContent Full SKILL.md text.
 */

/**
 * @typedef {Object} SkillSelectionDiagnostic
 * @property {string} code
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} message
 */

/**
 * Decide which skills this turn activates.
 *
 * @param {{
 *   prompt?: string,
 *   selection?: unknown,
 *   mode?: 'explicit' | 'legacy',
 *   nameCandidates: SkillCandidate[],
 *   resolveId: (id: string) => { candidate?: SkillCandidate, error?: string, kind?: string },
 *   ambiguousNames?: Set<string>,
 * }} input `nameCandidates` holds one winner per call name; `resolveId` looks an
 *   ID up in the scope of THIS send (a child sees only what its own scope has).
 * @returns {{
 *   mode: 'explicit' | 'legacy',
 *   selected: SkillCandidate[],
 *   diagnostics: SkillSelectionDiagnostic[],
 *   differences: { name: string, legacy: boolean, explicit: boolean, note: string }[],
 * }}
 */
export function selectSkills(input) {
  const prompt = String(input.prompt || '');
  const selection = normalizeSkillSelection(input.selection);
  const mode = input.mode === 'legacy' ? 'legacy' : 'explicit';
  /** @type {SkillSelectionDiagnostic[]} */
  const diagnostics = [];
  const legacyNames = new Set(
    input.nameCandidates.filter((entry) => isSkillSelectedLegacy(prompt, entry.name)).map((entry) => entry.name),
  );

  /** @type {SkillCandidate[]} */
  let selected = [];
  if (mode === 'legacy') {
    selected = input.nameCandidates.filter((entry) => legacyNames.has(entry.name));
  } else {
    const picked = new Map();
    const add = (candidate) => {
      const key = candidate.id || `name:${candidate.name.toLowerCase()}`;
      if (!picked.has(key)) picked.set(key, candidate);
    };
    for (const id of selection.skillIds) {
      const found = input.resolveId(id);
      if (found.candidate) add(found.candidate);
      else if (found.kind && found.kind !== 'skill') {
        diagnostics.push({ code: 'kind_not_activatable', id, message: `Selected ${found.kind} is listed but not activated by Cretli` });
      } else {
        diagnostics.push({ code: found.error || 'unknown_id', id, message: 'Selected skill ID is not available in this scope' });
      }
    }
    if (selection.parseMentions && prompt) {
      for (const name of extractActiveMentions(prompt)) {
        const candidate = input.nameCandidates.find((entry) => entry.name.toLowerCase() === name);
        // An explicit ID of the same name wins; the name table never adds a second one.
        const alreadyPicked = [...picked.values()].some((entry) => entry.name.toLowerCase() === name);
        if (candidate) {
          if (!alreadyPicked) add(candidate);
        } else if (input.ambiguousNames?.has(name)) {
          diagnostics.push({ code: 'ambiguous_name', name, message: `@${name} matches several skills; select by ID` });
        }
      }
    }
    selected = [...picked.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  const explicitNames = new Set(selected.map((entry) => entry.name));
  /** @type {{ name: string, legacy: boolean, explicit: boolean, note: string }[]} */
  const differences = [];
  for (const name of new Set([...legacyNames, ...explicitNames])) {
    const legacy = legacyNames.has(name);
    const explicit = explicitNames.has(name);
    if (legacy === explicit) continue;
    differences.push({
      name,
      legacy,
      explicit,
      note: legacy
        ? 'legacy keyword rule would activate it; explicit selection did not'
        : 'activated by explicit selection; the legacy rule would not have',
    });
  }
  return { mode, selected, diagnostics, differences };
}

/**
 * Prompt block for the selected skills.
 *
 * @param {SkillCandidate[]} selected
 * @returns {string}
 */
export function renderSelectedSkillsBlock(selected) {
  const parts = [];
  for (const entry of selected) {
    let body = '';
    try {
      body = entry.readContent();
    } catch {
      body = '';
    }
    parts.push(`[SKILL: ${entry.name}]`, body || `Read the full instructions of ${entry.name} before acting.`);
  }
  return parts.join('\n');
}

/**
 * Compact, content-free record of a selection for the send manifest.
 *
 * @param {ReturnType<typeof selectSkills>} result
 * @param {SkillSelection} selection
 * @returns {Record<string, any>}
 */
export function summarizeSkillSelection(result, selection) {
  return {
    mode: result.mode,
    requestedIds: selection.skillIds.length,
    parseMentions: selection.parseMentions,
    selectedIds: result.selected.map((entry) => entry.id).filter(Boolean),
    selectedNames: result.selected.map((entry) => entry.name),
    diagnostics: result.diagnostics.map((item) => ({ code: item.code, ...(item.id ? { id: item.id } : {}), ...(item.name ? { name: item.name } : {}) })),
    differencesFromLegacy: result.differences,
  };
}
