/**
 * Car view card list logic: ordering, ‹ › stepping, local "snooze" and the short
 * summary read aloud. Pure functions plus a small storage-backed snooze store,
 * no DOM and no network.
 */

import { toSpeakableText } from '../voice/speakableText.js';
import { collectWorkspaceFolders } from '../voice/voiceWorkspaceMatch.js';

/** A snoozed card is hidden in the car view for this long; the server is never told. */
export const CAR_SNOOZE_MS = 15 * 60 * 1000;
export const CAR_SNOOZE_STORAGE_KEY = 'cretli.car.snoozed';

const SUMMARY_MAX_HEADINGS = 3;
const SUMMARY_MAX_SENTENCES = 3;
const SUMMARY_MAX_CHARS = 420;

/**
 * This chat's cards first, then the rest, keeping the incoming (urgency) order.
 *
 * @param {Array<Record<string, any>>} cards
 * @param {string} [chatId]
 * @returns {Array<Record<string, any>>}
 */
export function orderCarCards(cards, chatId = '') {
  const list = Array.isArray(cards) ? cards.filter((card) => card && card.id) : [];
  if (!chatId) return list;
  return [
    ...list.filter((card) => card.subject?.chatId === chatId),
    ...list.filter((card) => card.subject?.chatId !== chatId),
  ];
}

/**
 * @param {Array<Record<string, any>>} cards
 * @param {string} cursorId
 * @returns {number} index of the cursor card, 0 when it is gone
 */
export function cursorIndex(cards, cursorId) {
  const index = cards.findIndex((card) => card.id === cursorId);
  return index >= 0 ? index : 0;
}

/**
 * Wrap-around step.
 *
 * @param {number} index
 * @param {number} length
 * @param {number} direction 1 = next, -1 = previous
 * @returns {number}
 */
export function stepCardIndex(index, length, direction) {
  if (!length) return 0;
  return (((index + direction) % length) + length) % length;
}

/**
 * Moves the cursor to the next/previous card.
 *
 * @param {Array<Record<string, any>>} cards ordered, visible cards
 * @param {string} cursorId
 * @param {number} direction
 * @returns {{ card: Record<string, any>|null, index: number, total: number }}
 */
export function stepCard(cards, cursorId, direction) {
  if (!cards.length) return { card: null, index: 0, total: 0 };
  const index = stepCardIndex(cursorIndex(cards, cursorId), cards.length, direction);
  return { card: cards[index], index, total: cards.length };
}

/**
 * @param {{ storage?: Pick<Storage, 'getItem'|'setItem'>|null, now?: () => number, ttlMs?: number }} [deps]
 */
export function createSnoozeStore(deps = {}) {
  const now = deps.now || (() => Date.now());
  const ttlMs = deps.ttlMs ?? CAR_SNOOZE_MS;
  const storage = deps.storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : deps.storage;

  /** @returns {Record<string, number>} live (unexpired) entries */
  function read() {
    let raw = {};
    try {
      raw = JSON.parse(storage?.getItem(CAR_SNOOZE_STORAGE_KEY) || '{}') || {};
    } catch {
      raw = {};
    }
    const at = now();
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => Number(until) > at));
  }

  function write(map) {
    try {
      storage?.setItem(CAR_SNOOZE_STORAGE_KEY, JSON.stringify(map));
    } catch {
      // A full or blocked storage only means the snooze does not survive a reload.
    }
  }

  return {
    /** @param {string} cardId */
    snooze(cardId) {
      if (!cardId) return;
      write({ ...read(), [cardId]: now() + ttlMs });
    },
    /** @param {string} cardId */
    isSnoozed(cardId) {
      return Object.hasOwn(read(), cardId);
    },
    /**
     * @param {Array<Record<string, any>>} cards
     * @returns {Array<Record<string, any>>}
     */
    visible(cards) {
      const live = read();
      return cards.filter((card) => !Object.hasOwn(live, card.id));
    },
  };
}

/** Server titles that carry no subject (e.g. "Activate lesson?"): the whole title is translated. */
const STATIC_TITLE_KINDS = new Set(['lesson_candidate']);

/** Kinds with an explanation of what deciding them changes (`car.about.<kind>`). */
const ABOUT_KINDS = new Set(['plan_approval', 'integration', 'policy_upgrade', 'lesson_candidate', 'scout_finding', 'permission', 'question', 'needs_human']);

/** Server-side gate options with fixed English labels; translated as `car.gateOption.<kind>.<id>.label|effect`. */
const KNOWN_OPTIONS = {
  lesson_candidate: new Set(['activate', 'withdraw']),
  scout_finding: new Set(['accept', 'reject']),
  permission: new Set(['once', 'reject']),
};

const TITLE_KEYS = {
  plan_approval: 'car.card.plan_approval',
  integration: 'car.card.integration',
  policy_upgrade: 'car.card.policy_upgrade',
};

/**
 * Localized title for the kinds the server titles in English; other kinds keep `card.title`.
 *
 * @param {Record<string, any>} card
 * @param {(key: string, params?: object) => string} translate
 * @returns {string}
 */
export function carCardTitle(card, translate) {
  if (card?.kind === 'lesson_aggregate') return translate('car.card.lesson_aggregate', { count: Number(card.count) || 0 });
  if (STATIC_TITLE_KINDS.has(String(card?.kind || ''))) return translate(`car.card.${card.kind}`);
  const key = TITLE_KEYS[String(card?.kind || '')];
  if (!key) return String(card?.title || '');
  // The server sets `summary` to the todo title for plan and integration cards.
  const title = String(card.summary || '').trim() || String(card.title || '').replace(/^[^:]+:\s*/, '');
  return translate(key, { title });
}

/**
 * Short spoken text: the first headings of the plan, else its first sentences.
 * Never the whole plan.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function summarizePlanMarkdown(markdown) {
  const source = String(markdown || '').replace(/\r\n/g, '\n');
  const headings = [];
  let inFence = false;
  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && line.match(/^#{1,4}\s+(.+?)\s*#*\s*$/);
    if (match) headings.push(match[1]);
    if (headings.length >= SUMMARY_MAX_HEADINGS) break;
  }
  let text = headings.length ? toSpeakableText(headings.join('. ')) : '';
  if (!text) {
    const prose = toSpeakableText(source.replace(/^#{1,6}\s+/gm, ''));
    const sentences = prose.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [];
    text = sentences.slice(0, SUMMARY_MAX_SENTENCES).map((sentence) => sentence.trim()).join(' ');
  }
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : text;
}

/**
 * @param {unknown} item card evidence entry
 * @returns {string}
 */
function evidenceText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const entry = /** @type {Record<string, any>} */ (item);
  return String(entry.text || entry.summary || entry.detail || entry.label || '');
}

/**
 * Text shown and read for the "Summary" button.
 *
 * @param {Record<string, any>} card
 * @param {{ planMarkdown?: string }} [extra] plan fetched from the todo API
 * @param {(key: string, params?: object) => string} translate
 * @returns {string} '' when there is nothing to summarize
 */
export function buildCardSummary(card, extra, translate) {
  const title = carCardTitle(card, translate);
  let body = '';
  if (card?.kind === 'plan_approval') {
    body = summarizePlanMarkdown(extra?.planMarkdown || '');
  } else {
    const evidence = (Array.isArray(card?.evidence) ? card.evidence : []).map(evidenceText).filter(Boolean);
    body = toSpeakableText(evidence.join('. ')) || toSpeakableText(String(card?.summary || ''));
    if (body.length > SUMMARY_MAX_CHARS) body = `${body.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  }
  return body ? `${title}. ${body}` : '';
}

/**
 * @param {Record<string, any>} card
 * @param {Record<string, any>} option
 * @returns {string} i18n key prefix for a known gate option, else ''
 */
function knownOptionKey(card, option) {
  const kind = String(card?.kind || '');
  const id = String(option?.id || '');
  return KNOWN_OPTIONS[kind]?.has(id) ? `car.gateOption.${kind}.${id}` : '';
}

/**
 * Button label: translated for server gates with fixed English labels, else the card's own label.
 *
 * @param {Record<string, any>} card
 * @param {Record<string, any>} option
 * @param {(key: string, params?: object) => string} translate
 * @returns {string}
 */
export function carOptionLabel(card, option, translate) {
  const key = knownOptionKey(card, option);
  return key ? translate(`${key}.label`) : String(option?.label || option?.id || '');
}

/**
 * What picking the option does, or '' when the card says nothing beyond its label.
 *
 * @param {Record<string, any>} card
 * @param {Record<string, any>} option
 * @param {(key: string, params?: object) => string} translate
 * @returns {string}
 */
export function carOptionEffect(card, option, translate) {
  const key = knownOptionKey(card, option);
  if (key) return translate(`${key}.effect`);
  const effect = String(option?.effect || '').trim();
  // Some producers put the option id or the label itself in `effect`.
  if (!effect || effect === option?.id || effect === String(option?.label || '').trim()) return '';
  return effect;
}

/** @param {string} folder @returns {string} last path segment */
function folderName(folder) {
  return String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
}

/**
 * Structured "what is this and what happens" view of a decision card.
 *
 * @param {Record<string, any>} card
 * @param {{ planMarkdown?: string }} [extra] plan fetched from the todo API
 * @param {(key: string, params?: object) => string} translate
 * @returns {{
 *   about: string,
 *   workspace: string,
 *   body: string,
 *   options: Array<{ label: string, effect: string, recommended: boolean }>,
 *   recommendation: { label: string, why: string }|null,
 * }}
 */
export function buildCardBrief(card, extra, translate) {
  const kind = String(card?.kind || '');
  const title = carCardTitle(card, translate);
  const summary = buildCardSummary(card, extra, translate);
  // buildCardSummary prefixes the title; the brief shows the title separately.
  let body = summary.startsWith(`${title}. `) ? summary.slice(title.length + 2) : summary;
  if (body && title.includes(body)) body = '';
  const options = (Array.isArray(card?.options) ? card.options : []).map((option) => ({
    label: carOptionLabel(card, option, translate),
    effect: carOptionEffect(card, option, translate),
    recommended: Boolean(card?.recommended) && option?.id === card.recommended,
  }));
  const picked = options.find((option) => option.recommended);
  const why = toSpeakableText(String(card?.why || ''));
  return {
    about: ABOUT_KINDS.has(kind) ? translate(`car.about.${kind}`) : '',
    workspace: folderName(card?.workspaceFolder),
    body,
    options,
    recommendation: picked ? { label: picked.label, why } : null,
  };
}

/**
 * Spoken form of the brief: title, what it is about, content, options and the recommendation.
 *
 * @param {Record<string, any>} card
 * @param {ReturnType<typeof buildCardBrief>} brief
 * @param {(key: string, params?: object) => string} translate
 * @returns {string}
 */
export function briefToSpeech(card, brief, translate) {
  const parts = [carCardTitle(card, translate)];
  if (brief.workspace) parts.push(translate('car.brief.workspace', { name: brief.workspace }));
  if (brief.about) parts.push(brief.about);
  if (brief.body) parts.push(brief.body);
  brief.options.forEach((option, index) => {
    parts.push(option.effect
      ? translate('car.brief.optionSpoken', { n: index + 1, label: option.label, effect: option.effect })
      : translate('car.brief.optionSpokenShort', { n: index + 1, label: option.label }));
  });
  if (brief.recommendation) {
    parts.push(brief.recommendation.why
      ? translate('car.brief.recommendedWhy', brief.recommendation)
      : translate('car.brief.recommended', brief.recommendation));
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(' ');
}

const sameFolder = (a, b) => String(a || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  === String(b || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Where "Open in the app" should land: the decision card itself, or the todo behind it when the
 * card is unusable, or just the decisions panel. A card of another workspace needs a switch first.
 *
 * @param {Record<string, any>|null|undefined} card
 * @param {string} [currentFolder] workspace the app currently shows
 * @returns {{ kind: 'decision'|'todo'|'panel'|'lessons', cardId?: string, todoId?: string, switchTo?: string }}
 */
export function pickOpenTarget(card, currentFolder = '') {
  if (!card?.id) return { kind: 'panel' };
  const folder = String(card.workspaceFolder || '');
  const switchTo = folder && currentFolder && !sameFolder(folder, currentFolder) ? folder : '';
  // The lessons aggregate is not a server card: it opens the Lessons settings of its workspace.
  if (card.kind === 'lesson_aggregate') return { kind: 'lessons', ...(switchTo ? { switchTo } : {}) };
  return { kind: 'decision', cardId: String(card.id), ...(switchTo ? { switchTo } : {}) };
}

/**
 * The registered workspace (and folder) that owns a card, for switching the app to it.
 *
 * @param {Record<string, any>|null|undefined} card
 * @param {Array<Record<string, any>>} workspaces loaded workspace entries
 * @returns {{ workspaceFile: string, folder: string }|null}
 */
export function findWorkspaceForCard(card, workspaces) {
  const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const list = (Array.isArray(workspaces) ? workspaces : []).filter((entry) => String(entry?.workspaceFile || '').trim());
  const cardFile = norm(card?.workspaceFile);
  const cardFolder = String(card?.workspaceFolder || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const byFile = cardFile ? list.find((entry) => norm(entry.workspaceFile) === cardFile) : null;
  const byFolder = !byFile && cardFolder
    ? list.find((entry) => collectWorkspaceFolders(entry).some((folder) => norm(folder.path) === norm(cardFolder)))
    : null;
  const found = byFile || byFolder;
  return found ? { workspaceFile: String(found.workspaceFile), folder: cardFolder } : null;
}

/**
 * Read-back for a spoken pick on a card (used for confirmation prompts).
 *
 * @param {Record<string, any>} card
 * @param {string} label chosen option label
 * @param {(key: string, params?: object) => string} translate
 * @returns {string}
 */
export function carPickReadback(card, label, translate) {
  return translate('car.choosingOn', { label, title: carCardTitle(card, translate) });
}
