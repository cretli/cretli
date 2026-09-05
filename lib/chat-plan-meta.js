/**
 * Parse and format the Cretli plan file marker comment.
 */

const MARKER_RE = /<!--\s*cretli-chat-plan:([^\s>]+)([^>]*)-->/;

/**
 * @param {unknown} markdown
 * @returns {{
 *   chatId: string,
 *   revision: number,
 *   sourceTurnId: string,
 *   updatedAt: string,
 *   contentHash: string,
 * }}
 */
export function parseChatPlanMeta(markdown) {
  const text = String(markdown || '');
  const match = text.match(MARKER_RE);
  if (!match) {
    return {
      chatId: '',
      revision: 0,
      sourceTurnId: '',
      updatedAt: '',
      contentHash: '',
    };
  }
  const attrs = String(match[2] || '');
  return {
    chatId: String(match[1] || '').trim(),
    revision: readAttrNumber(attrs, 'rev'),
    sourceTurnId: readAttr(attrs, 'turn'),
    updatedAt: readAttr(attrs, 'at'),
    contentHash: readAttr(attrs, 'hash'),
  };
}

/**
 * @param {{
 *   chatId: string,
 *   revision: number,
 *   sourceTurnId?: string,
 *   updatedAt?: string,
 *   contentHash?: string,
 * }} meta
 * @returns {string}
 */
export function formatChatPlanMarker(meta) {
  const chatId = String(meta?.chatId || '').trim();
  const revision = Number(meta?.revision);
  const safeRev = Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 1;
  const parts = [`cretli-chat-plan:${chatId}`, `rev=${safeRev}`];
  const turn = String(meta?.sourceTurnId || '').trim();
  if (turn) parts.push(`turn=${turn}`);
  const updatedAt = String(meta?.updatedAt || '').trim();
  if (updatedAt) parts.push(`at=${updatedAt}`);
  const contentHash = String(meta?.contentHash || '').trim();
  if (contentHash) parts.push(`hash=${contentHash}`);
  return `<!-- ${parts.join(' ')} -->`;
}

/**
 * @param {string} attrs
 * @param {string} name
 * @returns {string}
 */
function readAttr(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}=([^\\s>]+)`));
  return match ? String(match[1] || '').trim() : '';
}

/**
 * @param {string} attrs
 * @param {string} name
 * @returns {number}
 */
function readAttrNumber(attrs, name) {
  const raw = readAttr(attrs, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.floor(value);
}
