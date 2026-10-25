/**
 * Tiny DOM builders for the Todo panel, so markup is assembled with
 * `createElement`.
 */

/**
 * @param {string} className Classes of the span (e.g. `mdi mdi-close`).
 * @param {boolean} [ariaHidden] Mark the span `aria-hidden="true"`.
 * @returns {HTMLSpanElement}
 */
export function createSpan(className = '', ariaHidden = false) {
  const span = document.createElement('span');
  if (className) span.className = className;
  if (ariaHidden) span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * Empty-list placeholder: an icon above one line of text.
 *
 * @param {string} iconClass MDI icon class (e.g. `mdi-filter-outline`).
 * @param {string} text
 * @returns {HTMLDivElement}
 */
export function createEmptyState(iconClass, text) {
  const wrap = document.createElement('div');
  wrap.className = 'todo-empty-state';
  const message = document.createElement('p');
  message.className = 'todo-empty';
  message.textContent = text;
  wrap.append(createSpan(`todo-empty-icon mdi ${iconClass}`, true), message);
  return wrap;
}

/**
 * Loading skeleton: a status region with `rowCount` pulsing rows.
 *
 * @param {number} rowCount
 * @param {string} label
 * @returns {HTMLDivElement}
 */
export function createListSkeleton(rowCount, label) {
  const skeleton = document.createElement('div');
  skeleton.className = 'todo-skeleton';
  skeleton.setAttribute('role', 'status');
  skeleton.setAttribute('aria-label', label);
  for (let index = 0; index < rowCount; index += 1) {
    const row = document.createElement('div');
    row.className = 'todo-skeleton-row';
    row.style.setProperty('--todo-skeleton-width', `${96 - ((index * 13) % 38)}%`);
    row.appendChild(document.createElement('span'));
    skeleton.appendChild(row);
  }
  return skeleton;
}
