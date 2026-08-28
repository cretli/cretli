/**
 * Rendering of @cursor/sdk events in xterm.
 * The run.stream() stream repeatedly emits a growing text — we print only the delta (no \\r\\n between tokens).
 * @see https://cursor.com/docs/sdk/typescript — Streaming, SDKMessage
 */

/**
 * @param {unknown} event
 * @returns {string}
 */
export function extractAssistantPlainText(event) {
  if (!event || typeof event !== 'object') return '';
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (ev.type !== 'assistant' || !ev.message || typeof ev.message !== 'object') return '';
  const msg = /** @type {Record<string, unknown>} */ (ev.message);
  const content = Array.isArray(msg.content) ? msg.content : [];
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = /** @type {Record<string, unknown>} */ (block);
    if (b.type === 'text' && typeof b.text === 'string') {
      out += b.text;
    }
  }
  return out;
}

/**
 * @param {object} chat
 * @param {string} accKey
 * @param {string} full
 * @returns {string}
 */
export function takeStreamDelta(chat, accKey, full) {
  if (typeof full !== 'string') return '';
  const prev = typeof chat[accKey] === 'string' ? chat[accKey] : '';
  if (full.length === 0) return '';
  if (prev.length === 0) {
    chat[accKey] = full;
    return full;
  }
  if (full.startsWith(prev)) {
    const d = full.slice(prev.length);
    chat[accKey] = full;
    return d;
  }
  if (full.length < prev.length && prev.startsWith(full)) {
    return '';
  }
  chat[accKey] = prev + full;
  return full;
}

/**
 * Clears the stream buffers (new WS connection, new run, user echo).
 *
 * @param {object} chat
 */
export function resetSdkStreamState(chat) {
  if (!chat || typeof chat !== 'object') return;
  delete chat._sdkAssistantAcc;
  delete chat._sdkThinkingAcc;
  delete chat._sdkThinkingLeadEmitted;
  delete chat._sdkActiveStream;
  delete chat._sdkNeedAssistSep;
}

/**
 * @param {string} status
 * @returns {string} ANSI foreground code (e.g. 32)
 */
function toolStatusColorCode(status) {
  const st = (status || '').toLowerCase();
  if (st.includes('complete') || st.includes('success') || st === 'done') return '32';
  if (st.includes('fail') || st.includes('error') || st.includes('cancel')) return '31';
  if (st.includes('running') || st.includes('pending')) return '33';
  return '36';
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function extractPlanPreview(event) {
  if (!event || typeof event !== 'object') return '';
  const ev = /** @type {Record<string, unknown>} */ (event);
  const args = ev.args && typeof ev.args === 'object' ? /** @type {Record<string, unknown>} */ (ev.args) : null;
  if (args && typeof args.plan === 'string') return args.plan;
  const result = ev.result;
  if (result && typeof result === 'object') {
    const r = /** @type {Record<string, unknown>} */ (result);
    if (typeof r.plan === 'string') return r.plan;
  }
  return '';
}

/**
 * @param {object} chat
 * @param {unknown} event
 * @returns {string}
 */
export function getSdkEventTerminalChunk(chat, event) {
  if (!event || typeof event !== 'object') return '';
  const ev = /** @type {Record<string, unknown>} */ (event);
  const t = ev.type;

  if (t === 'assistant') {
    if (chat._sdkActiveStream !== 'assistant') {
      delete chat._sdkAssistantAcc;
    }
    if (chat._sdkActiveStream === 'thinking') {
      delete chat._sdkThinkingAcc;
      chat._sdkThinkingLeadEmitted = false;
    }
    chat._sdkActiveStream = 'assistant';
    const full = extractAssistantPlainText(ev);
    const delta = takeStreamDelta(chat, '_sdkAssistantAcc', full);
    if (!delta) return '';
    if (chat._sdkNeedAssistSep) {
      chat._sdkNeedAssistSep = false;
      return `\r\n${delta}`;
    }
    return delta;
  }

  if (t === 'thinking') {
    if (chat._sdkActiveStream === 'assistant') {
      delete chat._sdkAssistantAcc;
    }
    chat._sdkActiveStream = 'thinking';
    const full = typeof ev.text === 'string' ? ev.text : '';
    const truncated = full.length > 8000 ? `${full.slice(0, 8000)}…` : full;
    const delta = takeStreamDelta(chat, '_sdkThinkingAcc', truncated);
    if (!delta) return '';
    if (!chat._sdkThinkingLeadEmitted) {
      chat._sdkThinkingLeadEmitted = true;
      let sep = '';
      if (chat._sdkNeedAssistSep) {
        chat._sdkNeedAssistSep = false;
        sep = '\r\n';
      }
      return `${sep}\r\n\x1b[36m[thinking]\x1b[0m ${delta}`;
    }
    return delta;
  }

  if (t === 'tool_call') {
    chat._sdkNeedAssistSep = true;
    const name = typeof ev.name === 'string' ? ev.name : '?';
    const nameLower = name.toLowerCase();
    const status = typeof ev.status === 'string' ? ev.status : '';
    const fg = toolStatusColorCode(status);
    if (nameLower === 'createplan') {
      const planPreview = extractPlanPreview(ev);
      const short = planPreview.length > 400 ? `${planPreview.slice(0, 400)}…` : planPreview;
      return `\r\n\x1b[35m━━\x1b[0m \x1b[1;35mPlan\x1b[0m \x1b[90m· ${status}\x1b[0m\r\n${short ? `\x1b[97m${short}\x1b[0m\r\n` : ''}`;
    }
    return `\r\n\x1b[90m│\x1b[0m \x1b[${fg}m●\x1b[0m \x1b[97m${name}\x1b[0m \x1b[90m· ${status}\x1b[0m\r\n`;
  }

  if (t === 'status') {
    const st = typeof ev.status === 'string' ? ev.status : '';
    const msg = typeof ev.message === 'string' ? ev.message : '';
    return `\r\n\x1b[35m━━\x1b[0m \x1b[1;35mstatus\x1b[0m \x1b[97m${st}\x1b[0m${msg ? `\x1b[90m  ${msg}\x1b[0m` : ''}\r\n`;
  }

  if (t === 'system') {
    return `\r\n\x1b[90m[system]\x1b[0m\r\n`;
  }

  if (t === 'user') {
    resetSdkStreamState(chat);
    return `\r\n\x1b[90m[user]\x1b[0m\r\n`;
  }

  if (t === 'task') {
    const tx = typeof ev.text === 'string' ? ev.text : '';
    return tx ? `\r\n\x1b[34m[task]\x1b[0m ${tx}\r\n` : '';
  }

  if (t === 'request') {
    return `\r\n\x1b[31m[request — user action required in the SDK]\x1b[0m\r\n`;
  }

  try {
    const s = JSON.stringify(ev);
    const short = s.length > 500 ? `${s.slice(0, 500)}…` : s;
    return `\r\n\x1b[90m${short}\x1b[0m\r\n`;
  } catch {
    return '\r\n\x1b[90m[sdk event]\x1b[0m\r\n';
  }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function textsOverlap(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const sample = Math.min(left.length, right.length, 120);
  if (sample < 24) return left === right;
  return left.slice(0, sample) === right.slice(0, sample)
    || left.includes(right)
    || right.includes(left);
}

/**
 * @param {string} prev
 * @param {string} full
 * @returns {string}
 */
export function projectStreamAccumulator(prev, full) {
  const previous = String(prev || '');
  const next = String(full || '');
  if (!next) return previous;
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  return `${previous}${next}`;
}
