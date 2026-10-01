/** Shared rating limits and labels. Kept free of Node-only dependencies for browser use. */
export const DELEGATION_RATING_RATERS = Object.freeze(['parent', 'user']);
export const DELEGATION_RATING_MIN_SCORE = 1;
export const DELEGATION_RATING_MAX_SCORE = 5;
export const DELEGATION_RATING_TAGS = Object.freeze([
  'missed_bug',
  'false_positive',
  'scope_creep',
  'too_slow',
  'great',
]);
export const MAX_DELEGATION_RATING_TAGS = 5;
export const MAX_DELEGATION_RATING_NOTE_LENGTH = 500;
export const DELEGATION_RATING_USER_WEIGHT = 2;
export const DELEGATION_RATING_PARENT_WEIGHT = 1;
