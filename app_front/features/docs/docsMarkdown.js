import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false });
const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);

export function safeDocUrl(value) {
  const url = String(value || '').trim();
  return /^(https?:\/\/|mailto:|#)/i.test(url) && ![...url].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ? url : null;
}

/** Build an allowlisted tree, never HTML. Raw HTML remains escaped text; images are labels. */
export function safeMarkdown(text) {
  function convert(tokens) {
    const root = [];
    const stack = [root];
    for (const token of tokens) {
      const parent = stack.at(-1);
      if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
      if (token.type === 'inline') { parent.push(...convert(token.children || [])); continue; }
      if (token.nesting === 1) {
        const type = token.type === 'link_open' ? 'a' : allowed.has(token.tag) ? token.tag : 'span';
        const node = { type, children: [], ...(type === 'a' ? { href: safeDocUrl(token.attrGet('href')) } : {}) };
        parent.push(node);
        stack.push(node.children);
      } else if (['fence', 'code_block', 'code_inline'].includes(token.type)) {
        parent.push({ type: token.type === 'code_inline' ? 'code' : 'pre', text: token.content });
      } else if (token.type === 'softbreak' || token.type === 'hardbreak') parent.push({ type: 'br' });
      else if (token.type === 'hr') parent.push({ type: 'hr' });
      else parent.push({ type: 'text', text: token.content || '' });
    }
    return root;
  }
  return convert(markdown.parse(String(text || ''), {}));
}
