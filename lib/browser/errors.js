/**
 * Shared Browser module error type (HTTP-facing codes and status).
 */

export class BrowserError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.status = status;
    /** @type {string | undefined} URL-policy code of a navigation denial (consent prompts key off it). */
    this.policyCode = undefined;
    /** @type {string | undefined} Normalized origin of a navigation denial. */
    this.origin = undefined;
    /** @type {string | undefined} Holder category of a busy external-CDP slot (`external-session-busy`). */
    this.holder = undefined;
  }
}
