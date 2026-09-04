/**
 * Resolves a spoken chat title against the open chat list.
 * Speech often says "chat" for UI titles that use Polish "Czat".
 */

const FILLER_WORDS = new Set(['otworz', 'open', 'pokaz', 'show', 'the', 'a', 'to']);
const CHAT_WORDS = new Set(['chat', 'czat']);

/**
 * @param {string} text
 * @returns {string[]}
 */
function tokensFrom(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (CHAT_WORDS.has(token) ? 'chat' : token));
}

/**
 * @param {string[]} tokens
 * @returns {string[]}
 */
function significantTokens(tokens) {
  const withoutFiller = tokens.filter((token) => !FILLER_WORDS.has(token));
  const withoutChat = withoutFiller.filter((token) => token !== 'chat');
  if (withoutChat.length > 0) return withoutChat;
  if (withoutFiller.length > 0) return withoutFiller;
  return tokens;
}

/**
 * @param {object} chat
 * @returns {string}
 */
function chatSpokenLabel(chat) {
  return String(chat?.title || '').trim() || 'untitled';
}

/**
 * @param {Array<object>} chats
 * @param {string} spoken
 * @returns {{ match?: object|null, ambiguous?: boolean, candidates?: string[] }}
 */
export function matchChatBySpokenTitle(chats, spoken) {
  const needle = significantTokens(tokensFrom(spoken));
  if (needle.length === 0) return { match: null };
  const items = Array.isArray(chats) ? chats.filter((chat) => chat && chat.id) : [];
  const scored = items
    .map((chat) => {
      const hay = significantTokens(tokensFrom(chatSpokenLabel(chat)));
      const exact = hay.join(' ') === needle.join(' ');
      const subset = needle.every((token) => hay.includes(token));
      return { chat, exact, subset };
    })
    .filter((entry) => entry.exact || entry.subset);
  const exacts = scored.filter((entry) => entry.exact);
  if (exacts.length === 1) return { match: exacts[0].chat };
  if (exacts.length > 1) {
    return { ambiguous: true, candidates: exacts.map((entry) => chatSpokenLabel(entry.chat)) };
  }
  const subsets = scored.filter((entry) => entry.subset);
  if (subsets.length === 1) return { match: subsets[0].chat };
  if (subsets.length > 1) {
    return { ambiguous: true, candidates: subsets.map((entry) => chatSpokenLabel(entry.chat)) };
  }
  return { match: null };
}
