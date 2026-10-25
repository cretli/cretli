/** Return pattern labels only: diagnostics must not repeat private values. */
export function findPrivateMatches(text, ctx = {}) {
  const value = String(text || '');
  const found = new Set();
  /** @type {[string, RegExp][]} */
  const patterns = [
    ['home path', /\/home\//i], ['user path', /\/Users\//i], ['Windows user path', /C:\\Users\\/i],
    ['private IPv4', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/],
  ];
  for (const [label, pattern] of patterns) if (pattern.test(value)) found.add(label);
  for (const match of value.matchAll(/[\w.+-]+@([\w.-]+\.[a-z]{2,})\b/gi)) {
    if (!['example.com', 'example.org'].includes(match[1].toLowerCase())) found.add('email');
  }
  for (const key of ['username', 'hostname']) {
    const token = String(ctx[key] || '');
    if (token.length < 3) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(value)) found.add(key);
  }
  const tokens = Array.isArray(ctx.privateTokens) ? ctx.privateTokens : String(ctx.privateTokens || '').split(',');
  for (const token of tokens.map((item) => item.trim()).filter(Boolean)) {
    if (value.toLowerCase().includes(token.toLowerCase())) found.add('private token');
  }
  return [...found];
}

export function assertScreenshotClean({ ocrText, domText, ctx }) {
  const matches = findPrivateMatches(`${domText || ''}\n${ocrText || ''}`, ctx);
  if (matches.length) {
    const error = Object.assign(new Error(`Privacy gate rejected screenshot: ${matches.join(', ')}`), { code: 4 });
    throw error;
  }
}
