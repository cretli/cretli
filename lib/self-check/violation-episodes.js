/**
 * Shared violation-episode registry for server self-check detectors.
 *
 * A detector is a pure "state -> observations" function; this registry turns the
 * observations into episode events and at most one notification per episode:
 *   - key = type + scope; states: open, acked, closed;
 *   - every violated observation bumps a monotonic occurrence counter (`count`),
 *     which is the version that settles ACK races (timestamps are never compared);
 *   - an occurrence after an ACK reopens the episode (one new notification),
 *     occurrences before it only bump the counter;
 *   - an "unknown" observation never opens or closes anything.
 * Notifications go through the existing notification store with an episode fingerprint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { publishNotification } from '../notifications/notification-store.ts';
import { notificationFingerprintWithEpisode } from '../notifications/notification-producers.ts';
import { sanitizeNotificationText } from '../notifications/notification-sanitize.ts';

export const VIOLATION_EPISODES_FILE = 'violation-episodes.json';
export const VIOLATION_EPISODES_SCHEMA_VERSION = 1;
export const DEFAULT_CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_EPISODES = 500;

// Bare provider-style tokens that the shared redactor does not catch (no `key=` prefix).
const BARE_TOKEN_RE = /\b(?:sk|pk|ghp|gho|xox[a-z]|AKIA)[-_A-Za-z0-9]{12,}/g;

/** Notification sanitising plus bare-token redaction. */
function cleanText(value, max) {
  return sanitizeNotificationText(String(value ?? '').replace(BARE_TOKEN_RE, '[redacted]'), max);
}

const ID_RE = /^[A-Za-z0-9_.:@-]{1,80}$/;

/** Event kinds returned from report(). */
export const EPISODE_EVENTS = Object.freeze(['opened', 'reopened', 'closed', 'suppressed']);

/** Type and scope are identifiers only: anything path/URL/secret-like is rejected, not stored. */
function cleanId(value) {
  const text = String(value ?? '').trim();
  if (!ID_RE.test(text) || cleanText(text, 200) !== text) return '';
  return text;
}

export function episodeKey(type, scope) {
  const t = cleanId(type);
  const s = cleanId(scope);
  return t && s ? `${t}|${s}` : '';
}

function loadDoc(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.schemaVersion === VIOLATION_EPISODES_SCHEMA_VERSION && raw.episodes && typeof raw.episodes === 'object') {
      return raw.episodes;
    }
  } catch {
    /* missing or corrupt file: start empty */
  }
  return {};
}

/**
 * @param {object} options
 * @param {string} options.dataDir directory holding the registry file
 * @param {() => number} [options.now] injected clock (ms)
 * @param {(input: object) => Promise<unknown>} [options.publish] notification sink
 * @param {number} [options.closedRetentionMs]
 */
export function createViolationEpisodeRegistry(options) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const retentionMs = options.closedRetentionMs ?? DEFAULT_CLOSED_RETENTION_MS;
  const file = path.join(options.dataDir, VIOLATION_EPISODES_FILE);
  const publish = options.publish || ((input) => publishNotification(/** @type {Record<string, unknown>} */ (input), { now }));
  let episodes = loadDoc(file);

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [key, ep] of Object.entries(episodes)) {
      if (ep.state === 'closed' && ep.closedAt <= cutoff) delete episodes[key];
    }
    const keys = Object.keys(episodes);
    if (keys.length > MAX_EPISODES) {
      const closed = keys.filter((k) => episodes[k].state === 'closed').sort((a, b) => episodes[a].closedAt - episodes[b].closedAt);
      for (const k of closed.slice(0, keys.length - MAX_EPISODES)) delete episodes[k];
    }
  }

  function save() {
    fs.mkdirSync(options.dataDir, { recursive: true });
    writeJsonAtomic(file, { schemaVersion: VIOLATION_EPISODES_SCHEMA_VERSION, episodes });
  }

  async function notify(ep, kind) {
    const base = `selfcheck:${ep.type}:${ep.scope}`;
    const input = {
      category: 'system',
      severity: 'warning',
      title: cleanText(`${kind === 'reopened' ? 'Violation recurred' : 'Violation'}: ${ep.type}`, 200),
      body: cleanText(ep.message || `${ep.type} (${ep.scope})`, 500),
      fingerprint: notificationFingerprintWithEpisode(base, `${ep.episode}r${ep.reopens}`),
    };
    try {
      await publish(input);
    } catch {
      /* a failing sink must not break the registry state machine */
    }
  }

  /**
   * @param {Array<{type: string, scope: string, status: 'violated'|'ok'|'unknown', message?: string}>} observations
   * @returns {Promise<Array<{event: string, key: string, count: number}>>}
   */
  async function report(observations) {
    const events = [];
    const toNotify = [];
    const t = now();
    for (const obs of observations || []) {
      const key = episodeKey(obs?.type, obs?.scope);
      if (!key) continue;
      const status = obs.status || 'violated';
      let ep = episodes[key];
      if (status === 'violated') {
        const message = cleanText(obs.message || '', 300);
        if (!ep || ep.state === 'closed') {
          ep = {
            key, type: cleanId(obs.type), scope: cleanId(obs.scope), state: 'open',
            episode: (ep?.episode || 0) + 1, reopens: 0, count: 1, ackedVersion: 0,
            firstAt: t, lastAt: t, ackedAt: 0, closedAt: 0, message,
          };
          episodes[key] = ep;
          events.push({ event: 'opened', key, count: ep.count });
          toNotify.push([{ ...ep }, 'opened']);
        } else if (ep.state === 'acked') {
          // Any occurrence counted after the ACK version reopens the episode, even in the same millisecond.
          ep.count += 1;
          ep.lastAt = t;
          if (message) ep.message = message;
          if (ep.count > ep.ackedVersion) {
            ep.state = 'open';
            ep.reopens += 1;
            events.push({ event: 'reopened', key, count: ep.count });
            toNotify.push([{ ...ep }, 'reopened']);
          }
        } else {
          ep.count += 1;
          ep.lastAt = t;
          if (message) ep.message = message;
          events.push({ event: 'suppressed', key, count: ep.count });
        }
      } else if (status === 'ok' && ep && ep.state !== 'closed') {
        ep.state = 'closed';
        ep.closedAt = t;
        events.push({ event: 'closed', key, count: ep.count });
      }
      // status 'unknown' (or anything else): deliberately no state change.
    }
    prune();
    save();
    for (const [ep, kind] of toNotify) await notify(ep, kind);
    return events;
  }

  /**
   * Acknowledge an episode up to `version` (default: the current counter). An ACK for a
   * version older than the current counter loses the race and leaves the episode open.
   */
  function ack(type, scope, version) {
    const key = episodeKey(type, scope);
    const ep = episodes[key];
    if (!ep || ep.state !== 'open') return { acked: false, reason: ep ? 'not_open' : 'unknown_episode' };
    const v = version == null ? ep.count : Number(version);
    if (!Number.isFinite(v)) return { acked: false, reason: 'invalid_version' };
    // A version beyond the counter would pre-silence occurrences that have not happened yet.
    if (v > ep.count) return { acked: false, reason: 'future_version' };
    if (v < ep.count) return { acked: false, reason: 'stale_version' };
    ep.state = 'acked';
    ep.ackedVersion = v;
    ep.ackedAt = now();
    save();
    return { acked: true, version: v };
  }

  function get(type, scope) {
    const ep = episodes[episodeKey(type, scope)];
    return ep ? { ...ep } : null;
  }

  function list() {
    return Object.values(episodes).map((ep) => ({ ...ep }));
  }

  prune();
  return { report, ack, get, list };
}
