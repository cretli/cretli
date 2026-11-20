/**
 * Review-lesson proposals in the car view. A workspace can hold hundreds of
 * `lesson_candidate` cards; a driver cannot page through them and they bury
 * the cards that matter. They are therefore taken out of the card list (navigation,
 * "N/M", "more waiting", announcements, voice) and shown as one aggregate card per
 * workspace at the end of the queue. Pure functions, no DOM and no network.
 */

export const LESSON_CANDIDATE_KIND = 'lesson_candidate';
export const LESSON_AGGREGATE_KIND = 'lesson_aggregate';
const AGGREGATE_ID_PREFIX = 'car-lessons:';

/** @param {Record<string, any>|null|undefined} card */
export function isLessonCandidateCard(card) {
  return String(card?.kind || '') === LESSON_CANDIDATE_KIND;
}

/** @param {Record<string, any>|null|undefined} card */
export function isLessonAggregateCard(card) {
  return String(card?.kind || '') === LESSON_AGGREGATE_KIND;
}

/**
 * Cards without the lesson proposals: what navigation, counts, announcements and voice may see.
 *
 * @param {Array<Record<string, any>>} cards
 * @returns {Array<Record<string, any>>}
 */
export function withoutLessonCards(cards) {
  return (Array.isArray(cards) ? cards : []).filter((card) => !isLessonCandidateCard(card));
}

/**
 * One synthetic card per workspace that has lesson proposals; none when there are none.
 * The aggregate carries no options, so nothing can be decided by voice.
 *
 * @param {Array<Record<string, any>>} cards
 * @returns {Array<Record<string, any>>}
 */
export function buildLessonAggregates(cards) {
  const groups = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!isLessonCandidateCard(card) || card.status !== 'pending') continue;
    const folder = String(card.workspaceFolder || '');
    const group = groups.get(folder) || { count: 0, workspaceFolder: folder, workspaceFile: String(card.workspaceFile || '') };
    group.count += 1;
    if (!group.workspaceFile && card.workspaceFile) group.workspaceFile = String(card.workspaceFile);
    groups.set(folder, group);
  }
  return [...groups.values()].map((group) => ({
    id: `${AGGREGATE_ID_PREFIX}${group.workspaceFolder}`,
    kind: LESSON_AGGREGATE_KIND,
    status: 'pending',
    count: group.count,
    workspaceFolder: group.workspaceFolder,
    workspaceFile: group.workspaceFile,
    options: [],
  }));
}

/**
 * Cards the driver pages through: real cards first, aggregates last.
 *
 * @param {Array<Record<string, any>>} cards ordered, unsnoozed cards (lessons still inside)
 * @param {{ includeAggregates?: boolean }} [opts] voice navigation leaves the aggregates out
 * @returns {Array<Record<string, any>>}
 */
export function buildNavCards(cards, opts = {}) {
  const regular = withoutLessonCards(cards);
  return opts.includeAggregates ? [...regular, ...buildLessonAggregates(cards)] : regular;
}
