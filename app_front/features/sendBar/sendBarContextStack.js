/**
 * Visibility bookkeeping of the send bar context stack (todo chip, attachments
 * and extra items such as the cheap-resume banner). The stack is hidden only
 * when every member is hidden, and must be re-evaluated whenever one changes.
 */

/**
 * @param {{ stack: { hidden: boolean, prepend: (el: object) => void }, members: Array<{ hidden: boolean }>, onChange?: () => void }} input
 * @returns {{ addItem: (element: { hidden: boolean }) => void, sync: () => void }}
 */
export function createSendBarContextStack({ stack, members, onChange }) {
  const items = [];
  function sync() {
    stack.hidden = members.every((member) => member.hidden) && items.every((item) => item.hidden);
    if (typeof onChange === 'function') onChange();
  }
  function addItem(element) {
    items.push(element);
    stack.prepend(element);
    sync();
  }
  return { addItem, sync };
}
