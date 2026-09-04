/**
 * Tracks OpenCode message IDs → roles so part.updated/delta events can be mapped
 * to assistant vs user turns (OpenCode emits parts for both).
 */

/** @typedef {'user' | 'assistant'} OpenCodeMessageRole */

export class OpenCodeMessageRegistry {
  constructor() {
    /** @type {Map<string, OpenCodeMessageRole>} */
    this.roles = new Map();
  }

  /**
   * @param {unknown} info
   */
  noteMessageUpdated(info) {
    if (!info || typeof info !== 'object') return;
    const record = /** @type {Record<string, unknown>} */ (info);
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const role = record.role === 'user' || record.role === 'assistant' ? record.role : '';
    if (!id || !role) return;
    this.roles.set(id, role);
  }

  /**
   * @param {string} messageId
   * @returns {OpenCodeMessageRole | null}
   */
  getRole(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return null;
    return this.roles.get(id) || null;
  }

  /**
   * @param {unknown} part
   * @returns {boolean}
   */
  isAssistantPart(part) {
    if (!part || typeof part !== 'object') return false;
    const record = /** @type {Record<string, unknown>} */ (part);
    const messageId = typeof record.messageID === 'string' ? record.messageID.trim() : '';
    if (!messageId) return false;
    return this.getRole(messageId) === 'assistant';
  }

  /**
   * @param {unknown} part
   * @returns {boolean}
   */
  isUserPart(part) {
    if (!part || typeof part !== 'object') return false;
    const record = /** @type {Record<string, unknown>} */ (part);
    const messageId = typeof record.messageID === 'string' ? record.messageID.trim() : '';
    if (!messageId) return false;
    return this.getRole(messageId) === 'user';
  }
}

/**
 * @param {unknown} event
 * @param {OpenCodeMessageRegistry} registry
 */
export function noteOpenCodeMessageFromEvent(event, registry) {
  if (!event || typeof event !== 'object' || !registry) return;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'message.updated') return;
  const properties = event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!properties?.info) return;
  registry.noteMessageUpdated(properties.info);
}
