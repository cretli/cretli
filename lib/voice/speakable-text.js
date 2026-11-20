/**
 * Turns agent Markdown into something worth listening to.
 *
 * Agent answers are mostly code, diffs, paths and links. Read verbatim they are
 * unusable, so anything that is not prose is dropped instead of being spelled
 * out character by character.
 */

/** Inline code longer than this is an identifier or a snippet, never prose. */
const MAX_INLINE_CODE_LENGTH = 24;

/** Force a flush when no sentence boundary shows up within this many characters. */
export const MAX_PENDING_SPEECH_LENGTH = 400;

/** Chrome drops the tail of long utterances, so everything is spoken in short pieces. */
const MAX_UTTERANCE_LENGTH = 220;

/**
 * @param {string} code
 * @returns {boolean}
 */
function isProseLikeInlineCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return false;
  if (raw.length > MAX_INLINE_CODE_LENGTH) return false;
  return !/[/\\<>{}()[\];=_|]|\.\w|::|--/.test(raw);
}

/**
 * Drops emphasis/code delimiters the pairing passes left behind (an answer that
 * is still streaming, or plain stray markers). `2 * 3` and `snake_case` stay.
 *
 * @param {string} input
 * @returns {string}
 */
function stripDanglingDelimiters(input) {
  let text = input.replace(/\*\*|__|~~/g, '').replace(/`/g, '');
  text = text.replace(/\*/g, (match, offset, whole) => {
    const before = offset === 0 ? ' ' : whole[offset - 1];
    const after = offset + 1 >= whole.length ? ' ' : whole[offset + 1];
    return /\s/.test(before) && /\s/.test(after) ? match : '';
  });
  return text.replace(/_/g, (match, offset, whole) => {
    const before = offset === 0 ? ' ' : whole[offset - 1];
    const after = offset + 1 >= whole.length ? ' ' : whole[offset + 1];
    if (/\w/.test(before) && /\w/.test(after)) return match;
    return /\s/.test(before) && /\s/.test(after) ? match : '';
  });
}

/**
 * Index where the part of a streaming answer that a later chunk could still
 * rewrite begins. Everything before it converts to the same speakable text no
 * matter what arrives next. Covers every rewriting pass of `toSpeakableText`;
 * returns `markdown.length` when nothing is open.
 *
 * @param {string} markdown
 * @returns {number}
 */
export function findUnstableTailStart(markdown) {
  const md = String(markdown || '').replace(/\r\n/g, '\n');
  let start = md.length;
  const mark = (index) => {
    if (index >= 0 && index < start) start = index;
  };

  // The last token is never settled: it may grow into a URL, path, file name or tag.
  const lastToken = /\S+$/.exec(md);
  if (lastToken) mark(lastToken.index);

  // Fences and comments swallow everything after an unclosed opener.
  let cursor = 0;
  while (cursor < md.length) {
    const open = /```|~~~|<!--/.exec(md.slice(cursor));
    if (!open) break;
    const at = cursor + open.index;
    const closer = open[0] === '<!--' ? '-->' : open[0];
    const close = md.indexOf(closer, at + open[0].length);
    if (close < 0) {
      mark(at);
      break;
    }
    cursor = close + closer.length;
  }
  // Partial openers at the very end (`` ` ``, `~~`, `<!`) are covered by the last-token rule.

  // Links and images: an opener whose target is not complete yet.
  const linkScan = /!?\[/g;
  let link = linkScan.exec(md);
  while (link) {
    const rest = md.slice(link.index);
    const complete = /^!?\[[^\]]*\]\([^)]*\)/.exec(rest);
    if (complete) {
      linkScan.lastIndex = link.index + complete[0].length;
    } else {
      const closeBracket = rest.indexOf(']');
      const afterBracket = closeBracket >= 0 ? rest.slice(closeBracket + 1) : '';
      // `[x] done` can never become a link; `[x]` at the end or `[x](` still can.
      if (closeBracket < 0 || afterBracket === '' || afterBracket[0] === '(') {
        mark(link.index);
        break;
      }
    }
    link = linkScan.exec(md);
  }

  // Unpaired delimiters: the last one of an odd group may still find its partner.
  const lastOdd = (re) => {
    let count = 0;
    let last = -1;
    let m = re.exec(md);
    while (m) {
      count += 1;
      last = m.index;
      m = re.exec(md);
    }
    return count % 2 === 1 ? last : -1;
  };
  mark(lastOdd(/\*\*/g));
  mark(lastOdd(/__/g));
  const lines = md.split('\n');
  let offset = 0;
  for (const line of lines) {
    const lineEnd = offset + line.length;
    const countIn = (re) => {
      let count = 0;
      let last = -1;
      let m = re.exec(line);
      while (m) {
        count += 1;
        last = offset + m.index;
        m = re.exec(line);
      }
      return count % 2 === 1 ? last : -1;
    };
    mark(countIn(/`/g));
    mark(countIn(/~~/g));
    mark(countIn(/(?<!\*)\*(?!\*)(?!\s)|(?<!\s)(?<!\*)\*(?!\*)/g));
    mark(countIn(/(?<![\w_])_(?!_)(?=\S)|(?<=\S)(?<!\w)_(?!_)/g));
    offset = lineEnd + 1;
  }

  // The last line: a block marker, table row or title JSON is still being typed.
  const lastLineStart = md.lastIndexOf('\n') + 1;
  const lastLine = md.slice(lastLineStart);
  if (
    /^\s*\|/.test(lastLine)
    || /^\s*\{/.test(lastLine)
    || /^\s{0,3}(?:#{1,6}|>|\d+[.)]?|[-*+=]|(?:[-*_][ \t]*)+)\s*$/.test(lastLine)
  ) {
    mark(lastLineStart);
  }
  // HTML tag still open.
  const lastLt = md.lastIndexOf('<');
  if (lastLt >= 0 && md.indexOf('>', lastLt) < 0) mark(lastLt);

  return start;
}

/**
 * @param {string} markdown
 * @returns {string}
 */
export function toSpeakableText(markdown) {
  let text = String(markdown || '');
  if (!text.trim()) return '';
  text = text.replace(/\r\n/g, '\n');

  // The trailing title JSON names the run in the UI; it is not part of the answer.
  text = text.replace(/```(?:json)?[ \t]*\n\s*\{\s*"title"[\s\S]*?```[ \t]*$/i, ' ');
  text = text.replace(/^[ \t]*\{\s*"title"\s*:[^\n]*\}[ \t]*$/gm, ' ');

  // Fenced blocks cover code, mermaid diagrams and Cretli code references.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ');
  // An unclosed comment swallows the rest of the text, like an unclosed fence.
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');

  // Images first — otherwise the link rule below promotes alt text to prose.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // A half-written image or link must not leak its brackets while streaming.
  text = text.replace(/!\[[^\]\n]*\]\([^)\n]*$/gm, ' ');
  text = text.replace(/!\[[^\]\n]*$/gm, ' ');
  text = text.replace(/\[([^\]\n]*)\]\([^)\n]*$/gm, '$1');
  text = text.replace(/\[(?=[^\]]*$)/g, '');

  text = text.replace(/`([^`\n]*)`/g, (_match, code) => (isProseLikeInlineCode(code) ? code : ' '));

  text = text
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .join('\n');

  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*_][ \t]*){3,}$/gm, ' ');

  text = text.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/~~([^~\n]+)~~/g, '$1');
  text = stripDanglingDelimiters(text);

  text = text.replace(/\bhttps?:\/\/\S+/gi, ' ');
  text = text.replace(/<\/?[a-z][^>]*>/gi, ' ');
  // Paths and file names: a slash-separated token, or a bare name with an extension.
  text = text.replace(/(^|\s)(?:\.{0,2}\/)?[\w.-]+\/[\w./-]*/g, '$1 ');
  text = text.replace(/(^|\s)[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|scss|css|html|php|py|md|yml|yaml|sh|env)\b/gi, '$1 ');

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits off the part that is safe to speak now, so streaming answers are read
 * in whole sentences instead of word fragments.
 *
 * @param {string} text
 * @param {{ force?: boolean }} [options]
 * @returns {{ ready: string, consumed: number }} `consumed` counts characters of
 *   the input covered by `ready`, including the whitespace trimmed off it.
 */
export function takeCompleteSentences(text, options = {}) {
  const raw = String(text || '');
  if (!raw) return { ready: '', consumed: 0 };

  const boundary = /(?:[.!?…]["')\]]*\s)|(?:\n\s*\n)/g;
  let consumed = 0;
  let match = boundary.exec(raw);
  while (match !== null) {
    consumed = match.index + match[0].length;
    match = boundary.exec(raw);
  }

  if (consumed > 0) return { ready: raw.slice(0, consumed).trim(), consumed };
  if (options.force === true) return { ready: raw.trim(), consumed: raw.length };
  if (raw.length < MAX_PENDING_SPEECH_LENGTH) return { ready: '', consumed: 0 };

  // No punctuation in a long run (tables, lists, logs): break on the last space
  // so the utterance never ends mid-word.
  const lastSpace = raw.lastIndexOf(' ');
  if (lastSpace <= 0) return { ready: '', consumed: 0 };
  return { ready: raw.slice(0, lastSpace).trim(), consumed: lastSpace + 1 };
}

/**
 * Cuts a passage into utterance-sized pieces on sentence, then word boundaries.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitForUtterances(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.length <= MAX_UTTERANCE_LENGTH) return [raw];

  /** @type {string[]} */
  const pieces = [];
  let current = '';
  const sentences = raw.split('\n').flatMap((line) => line.match(/[^.!?…]+[.!?…]*/g) || []);
  for (const sentence of sentences) {
    const part = sentence.trim();
    if (!part) continue;
    if (!current) current = part;
    else if (current.length + part.length + 1 <= MAX_UTTERANCE_LENGTH) current += ` ${part}`;
    else {
      pieces.push(current);
      current = part;
    }
  }
  if (current) pieces.push(current);

  /** @type {string[]} */
  const result = [];
  for (const piece of pieces) {
    if (piece.length <= MAX_UTTERANCE_LENGTH) {
      result.push(piece);
      continue;
    }
    let rest = piece;
    while (rest.length > MAX_UTTERANCE_LENGTH) {
      const window = rest.slice(0, MAX_UTTERANCE_LENGTH);
      const cut = window.lastIndexOf(' ');
      const at = cut > MAX_UTTERANCE_LENGTH / 2 ? cut : MAX_UTTERANCE_LENGTH;
      result.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) result.push(rest);
  }
  return result.filter(Boolean);
}
