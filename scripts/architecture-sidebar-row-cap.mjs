/**
 * Pure classification of one measured sidebar state against the frozen
 * rendered-row cap (docs/architecture-baseline.md section 5).
 *
 * The legacy renderer can render slightly more rows than the cap because the
 * frozen exception list allows focus, drag and the active row. Ancestor rows of
 * the active chat are a separate, still open human decision, so they never
 * count as an allowed exception. Exceptions only matter once the cap is
 * actually exceeded: a state with `renderedRows <= cap` satisfies the cap even
 * when it happens to contain an active row nested under its parent.
 */

/** Frozen rendered-row cap (docs/architecture-baseline.md section 5). */
export const RENDERED_ROW_CAP = 300;

/**
 * @param {{
 *   cap?: number,
 *   renderedRows: number,
 *   allowedExceptions?: number,
 *   ancestorRows?: number,
 * }} state
 * @returns {{
 *   cap: number,
 *   renderedRows: number,
 *   rowsOverCap: number,
 *   allowedExceptions: number,
 *   ancestorRows: number,
 *   unclassifiedRows: number,
 *   rowCapOk: boolean,
 *   ancestorDecisionOpen: boolean,
 * }}
 */
export function classifyRowCap({ cap = RENDERED_ROW_CAP, renderedRows, allowedExceptions = 0, ancestorRows = 0 }) {
  const rows = Math.max(0, renderedRows || 0);
  const rowsOverCap = Math.max(0, rows - cap);
  const allowed = Math.max(0, allowedExceptions || 0);
  const ancestors = Math.max(0, ancestorRows || 0);
  const unclassifiedRows = Math.max(0, rowsOverCap - allowed);
  // Ancestors matter only when the cap is exceeded; below the cap the state is
  // compliant no matter how the active row is nested.
  const ancestorDecisionOpen = rowsOverCap > 0 && ancestors > 0;
  const rowCapOk = rowsOverCap === 0 || (unclassifiedRows === 0 && !ancestorDecisionOpen);
  return {
    cap,
    renderedRows: rows,
    rowsOverCap,
    allowedExceptions: allowed,
    ancestorRows: ancestors,
    unclassifiedRows,
    rowCapOk,
    ancestorDecisionOpen,
  };
}
