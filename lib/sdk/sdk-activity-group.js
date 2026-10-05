/**
 * Consecutive tool calls share one Activity card until a real turn boundary
 * (user, assistant, plan, thinking). Full tool twins, waiting rows, and
 * status lines are spacers: they do not start a new card.
 */

/**
 * Index of the Activity tray to extend, or -1 when the next tool starts a card.
 * `anchorIndex` is the later sibling the tool is inserted before; -1 appends.
 *
 * @param {Array<{ spacer?: boolean, hasTray?: boolean }>} nodes
 * @param {number} [anchorIndex]
 * @returns {number}
 */
export function findPrecedingActivityTrayIndex(nodes, anchorIndex = -1) {
  const list = Array.isArray(nodes) ? nodes : [];
  const anchor = Number(anchorIndex);
  let index = Number.isInteger(anchor) && anchor >= 0 ? anchor - 1 : list.length - 1;
  for (; index >= 0; index -= 1) {
    const node = list[index];
    if (!node || node.spacer === true) continue;
    if (node.hasTray === true) return index;
    return -1;
  }
  return -1;
}
