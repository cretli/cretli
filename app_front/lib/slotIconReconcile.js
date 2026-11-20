/**
 * Light-DOM icon reconciliation for Lit hosts that project `.mdi` spans through
 * named slots. Any child mutation fires `slotchange`, so an unchanged icon set
 * must produce zero DOM operations.
 */

/**
 * DOM-free decision: which operations bring the existing icons to the wanted set.
 *
 * @param {Array<{ slot: string, className: string }>} existing Current icon children
 * @param {Map<string, string>} wanted slot name -> mdi icon class (e.g. `mdi-check`)
 * @returns {Array<{ op: 'remove'|'create'|'class', slot: string, className?: string }>}
 */
export function planSlotIconOps(existing, wanted) {
  const ops = [];
  const bySlot = new Map();
  for (const item of existing) {
    if (!wanted.has(item.slot) || bySlot.has(item.slot)) ops.push({ op: 'remove', slot: item.slot });
    else bySlot.set(item.slot, item);
  }
  for (const [slot, iconName] of wanted) {
    const className = `mdi ${iconName}`;
    const current = bySlot.get(slot);
    if (!current) ops.push({ op: 'create', slot, className });
    else if (current.className !== className) ops.push({ op: 'class', slot, className });
  }
  return ops;
}

/**
 * @param {any} host Element-like with `children`, `appendChild`
 * @param {Map<string, string>} wanted
 * @param {() => any} createEl Creates an empty span
 */
export function reconcileSlotIcons(host, wanted, createEl) {
  const icons = Array.from(host.children).filter((el) => el.hasAttribute('data-cr-icon'));
  const ops = planSlotIconOps(
    icons.map((el) => ({ slot: el.getAttribute('slot') || '', className: el.className })),
    wanted,
  );
  const seen = new Set();
  for (const op of ops) {
    if (op.op === 'create') {
      const el = createEl();
      el.setAttribute('data-cr-icon', '');
      el.setAttribute('slot', op.slot);
      el.setAttribute('aria-hidden', 'true');
      el.className = /** @type {string} */ (op.className);
      host.appendChild(el);
      continue;
    }
    // Remove: first not-yet-claimed match by slot; class: the unique match.
    const idx = icons.findIndex((el, i) => !seen.has(i) && (el.getAttribute('slot') || '') === op.slot);
    if (idx < 0) continue;
    seen.add(idx);
    if (op.op === 'remove') icons[idx].remove();
    else icons[idx].className = /** @type {string} */ (op.className);
  }
}
