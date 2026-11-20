import { nothing, render } from 'lit';

/**
 * Render a Lit template into a Usage host element. Lit keeps its own part
 * state on the host, so repeated calls patch the DOM instead of rebuilding it.
 * Works for `thead`, `tbody` and `select` hosts as well.
 *
 * @param {Element|null|undefined} target
 * @param {unknown} template lit TemplateResult, array, string or `nothing`
 */
export function renderUsage(target, template) {
  if (!target) return;
  render(template ?? nothing, /** @type {HTMLElement} */ (target));
}

/** @param {Element|null|undefined} target */
export function clearUsageContent(target) {
  renderUsage(target, nothing);
}
