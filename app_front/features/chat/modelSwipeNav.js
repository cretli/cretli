import { decodeNewChatModelChoice, encodeNewChatModelChoice } from './newChatModelOptions.js';

/**
 * Neighbour lookup for the swipe gesture on the chat model picker. Vertical swipes walk
 * through the models of every harness in picker order, horizontal swipes walk through the
 * effort variants of the current model. Pure so it can be tested without a DOM.
 */

/** @typedef {{ value: string, disabled?: boolean, variantOf?: string, variantRank?: number, isDefault?: boolean }} PickerRow */

/** Rows that can be chosen, in picker order. */
function selectableRows(options) {
  return (Array.isArray(options) ? options : []).filter((row) => row && !row.disabled && decodeNewChatModelChoice(row.value));
}

/** Rows that belong to the same model (differ only by effort) share this key. */
function groupKey(row) {
  return row.variantOf || row.value;
}

/** Effort rank of a row; rows without effort sort first. */
function rankOf(row) {
  return Number.isFinite(row.variantRank) ? row.variantRank : -1;
}

/**
 * @param {PickerRow[]} options
 * @param {string} harness
 * @param {string} model
 * @param {'model' | 'effort'} axis
 * @param {1 | -1} dir +1 = next model / more effort, -1 = previous model / less effort
 * @returns {{ harness: string, model: string, value: string } | null} null at the end of the list
 */
export function swipeNeighbour(options, harness, model, axis, dir) {
  const rows = selectableRows(options);
  const currentValue = encodeNewChatModelChoice(harness, model);
  const current = rows.find((row) => row.value === currentValue);
  if (!current) return null;
  const result = (row) => {
    const choice = decodeNewChatModelChoice(row.value);
    return choice ? { harness: choice.harness, model: choice.model, value: row.value } : null;
  };
  const key = groupKey(current);

  if (axis === 'effort') {
    const variants = rows.filter((row) => groupKey(row) === key && Number.isFinite(row.variantRank))
      .sort((a, b) => rankOf(a) - rankOf(b));
    const at = variants.findIndex((row) => row.value === current.value);
    const next = variants[at + dir];
    return at < 0 || !next ? null : result(next);
  }

  const keys = [...new Set(rows.map(groupKey))];
  const nextKey = keys[keys.indexOf(key) + dir];
  if (nextKey === undefined) return null;
  const variants = rows.filter((row) => groupKey(row) === nextKey);
  // Keep the thinking level when the next model offers it, else the closest one.
  const wanted = rankOf(current);
  const closest = [...variants].sort((a, b) => Math.abs(rankOf(a) - wanted) - Math.abs(rankOf(b) - wanted))[0];
  const pick = variants.find((row) => rankOf(row) === wanted)
    || (wanted >= 0 ? closest : variants.find((row) => row.isDefault) || variants[0]);
  return result(pick);
}
