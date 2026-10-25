/**
 * Leaf module (no imports) so low-level text builders can mark bounded text
 * without pulling in the budget module.
 */

/**
 * Marker for text that was bounded. The marker always says how much was kept,
 * how much existed and where the full content lives, so a reader (or the model)
 * knows the text is partial. Pure; callers decide where to put it.
 */
export function buildTruncationMarker(input: { kept: number, total: number, unit?: string, ref?: string, side?: 'head' | 'tail' }): string {
  const unit = input.unit || 'chars';
  const kept = Math.max(0, Math.floor(Number(input.kept) || 0));
  const total = Math.max(kept, Math.floor(Number(input.total) || 0));
  const ref = String(input.ref || '').trim();
  const side = input.side === 'tail' ? 'last' : 'first';
  return `[truncated: ${side} ${kept} of ${total} ${unit}${ref ? `; full content: ${ref}` : '; full content not retained here'}]`;
}
