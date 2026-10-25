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
  }
}
