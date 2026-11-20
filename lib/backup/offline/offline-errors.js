/** Typed errors of the offline data backup/restore tooling (B4). */
export class OfflineDataError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OfflineDataError';
    this.code = code;
    this.details = details;
  }
}
