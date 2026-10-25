/**
 * Parse `codex login --device-auth` stdout (browser URL + one-time code).
 * Ignore API URLs from error text such as /api/accounts/deviceauth/usercode.
 */

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const ANY_AUTH_URL_RE = /https:\/\/auth\.openai\.com\/[^\s)]+/gi;
const HYPHEN_CODE_RE = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/;
const LABELED_CODE_RE = /(?:enter code|one-time code|device code)[^\n]*?\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/i;

export function stripAnsi(text: string): string {
  return String(text || '').replace(ANSI_RE, '');
}

function normalizeAuthUrl(rawUrl: string): string {
  return String(rawUrl || '').replace(/[).,]+$/, '');
}

function extractBrowserLoginUrl(text: string): string {
  const matches = String(text || '').match(ANY_AUTH_URL_RE) || [];
  for (const raw of matches) {
    const url = normalizeAuthUrl(raw);
    try {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/api/')) continue;
      return url;
    } catch {
      continue;
    }
  }
  return '';
}

export function parseCodexDeviceAuthOutput(text: string): { url: string, userCode: string } {
  const raw = stripAnsi(text);
  const labeled = raw.match(LABELED_CODE_RE);
  const hyphen = raw.match(HYPHEN_CODE_RE);
  return {
    url: extractBrowserLoginUrl(raw),
    userCode: (labeled && labeled[1] ? labeled[1] : (hyphen ? hyphen[1] : '')).trim(),
  };
}
