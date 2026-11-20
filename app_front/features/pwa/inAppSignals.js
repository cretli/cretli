/**
 * In-app vibration and sound signals for the OPEN app.
 *
 * A single event (finished run / question / permission) must produce at most
 * one application-level signal, even when several Cretli cards/tabs are open.
 * The decision logic is pure and dependency-injected so it can be unit tested
 * in Node without a browser; the browser glue (Web Audio, navigator.vibrate,
 * Storage) is created by `initInAppSignals()`.
 *
 * Division of labour:
 * - foreground visible card: this module plays the signal (source `live`);
 * - background / screen off: the Service Worker owns the OS notification and
 *   posts `cretli-in-app-signal` to a visible client (source `sw`).
 *
 * Both paths share the same per-eventId claim so push and the app never double
 * a sound or a vibration. Replayed history / reconnect / resume / inbox events
 * are rejected as stale sources instead of re-signalling.
 *
 * Design rules:
 * - Never throw and never surface an error inside a chat: unsupported APIs and
 *   a blocked autoplay are reported as state, not as an exception.
 * - Preferences come from `lib/push-preferences.js` (`inAppVibrate`,
 *   `inAppSound`, per-event toggles). Both channels are off by default.
 */
import {
  CHAT_ALERT_COOLDOWN_MS,
  isChatMuted,
  normalizeChatMuteRecord,
  resolveChatAlertThrottle,
  setChatMuted,
} from '../../../lib/chat-mute.js';
import {
  NOTIFICATION_SOUND_PRESETS,
  normalizePushPreferences,
  resolveNotificationProfile,
  resolveNotificationScope,
  resolvePushVibratePattern,
} from '../../../lib/push-preferences.js';
import {
  isQuietHoursActive,
  normalizeQuietHours,
} from '../../../lib/push-quiet-hours.js';
import {
  PUSH_IN_APP_VOLUME_DEFAULT,
  clampPushInAppVolume,
  createIndexedDbPersistence,
  createPushPreferencesStore,
} from './pushPreferencesStore.js';

/** Event types that can carry an in-app signal. */
export const IN_APP_SIGNAL_EVENT_TYPES = Object.freeze(['finished', 'question', 'permission', 'newChat']);

/** Service-worker -> page message carrying a background signal. */
export const IN_APP_SIGNAL_MESSAGE = 'cretli-in-app-signal';

/** Page -> service-worker reply confirming the in-app signal was handled. */
export const IN_APP_SIGNAL_HANDLED = 'cretli-in-app-signal-handled';

/** BroadcastChannel name used for best-effort cross-card claim sharing. */
export const IN_APP_SIGNAL_CHANNEL = 'cretli-in-app-signals';

/** Cross-tab claim key prefix (localStorage). */
export const IN_APP_SIGNAL_CLAIM_PREFIX = 'cretli-in-app-signal:';

/** Claim key namespace for notification-centre items (kept apart from run events). */
export const NOTIFICATION_SIGNAL_CLAIM_PREFIX = 'notification-center:';

/** How long an eventId stays claimed (one event never signals twice). */
export const IN_APP_SIGNAL_CLAIM_TTL_MS = 60 * 1000;

/** Default in-app vibration pattern (matches the historical push default). */
export const IN_APP_SIGNAL_VIBRATE_PATTERN = Object.freeze([80, 40, 80]);

/** Short Web Audio tone (no audio asset shipped in the repo). */
export const IN_APP_SIGNAL_TONE = Object.freeze({
  frequency: 880,
  durationMs: 180,
  gain: 0.18,
});

/** Sources that may emit an application signal. */
const LIVE_SOURCES = Object.freeze(['live', 'sw']);

/** Sources that must never emit (stale replays). */
const STALE_SOURCES = Object.freeze([
  'history',
  'replay',
  'resume',
  'reconnect',
  'inbox',
  'boot',
  'hydrate',
  'backfill',
]);

/**
 * Decision reasons that mean the page deliberately stayed silent. The OS
 * notification must not vibrate either, otherwise a quiet-hour, muted-chat or
 * throttled event would produce the second signal this feature prevents.
 */
const SUPPRESSED_SIGNAL_REASONS = Object.freeze([
  'duplicate',
  'quiet-hours',
  'chat-muted',
  'alert-throttled',
]);

/**
 * Map many spellings of a transport/event kind to a canonical signal type.
 *
 * @param {unknown} value
 * @returns {'' | 'finished' | 'question' | 'permission' | 'newChat'}
 */
export function resolveSignalEventType(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return '';
  if (raw === 'finished' || raw === 'run-finished' || raw === 'agent-finished') return 'finished';
  if (
    raw === 'question'
    || raw === 'needs-input'
    || raw === 'agent-needs-input'
    || raw === 'opencode_question'
  ) {
    return 'question';
  }
  if (raw === 'permission' || raw === 'opencode_permission') return 'permission';
  if (raw === 'newchat' || raw === 'new-chat' || raw === 'chat-created') return 'newChat';
  return '';
}

/**
 * Pure signal decision.
 *
 * @param {{
 *   preferences?: unknown,
 *   eventType?: unknown,
 *   eventId?: unknown,
 *   notificationScope?: 'chat' | 'subchat',
 *   delegationParentChatId?: unknown,
 *   forkParentChatId?: unknown,
 *   seenEventIds?: Iterable<string> | string[] | null,
 *   isSeen?: (eventId: string) => boolean,
 *   foreground?: boolean,
 *   source?: string,
 *   vibrateSupported?: boolean,
 *   soundSupported?: boolean,
 *   quietActive?: boolean,
 *   chatMuted?: boolean,
 * }} [input]
 * @returns {{ emit: boolean, vibrate: boolean, sound: boolean, reason: string, eventType: string, eventId: string }}
 */
export function resolveInAppSignalDecision(input = {}) {
  const eventType = resolveSignalEventType(input.eventType);
  const eventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
  const source = typeof input.source === 'string' && input.source.trim()
    ? input.source.trim().toLowerCase()
    : 'live';
  const foreground = input.foreground !== false;
  const preferences = normalizePushPreferences(input.preferences);
  const profile = resolveNotificationProfile(preferences, input);
  const vibrateSupported = input.vibrateSupported !== false;
  const soundSupported = input.soundSupported !== false;

  /** @type {(id: string) => boolean} */
  let isSeen;
  if (typeof input.isSeen === 'function') {
    isSeen = input.isSeen;
  } else {
    const seen = input.seenEventIds;
    isSeen = (id) => {
      if (!seen) return false;
      if (typeof seen.has === 'function') return seen.has(id);
      if (Array.isArray(seen)) return seen.includes(id);
      return false;
    };
  }

  const reject = (reason) => ({
    emit: false,
    vibrate: false,
    sound: false,
    reason,
    eventType,
    eventId,
  });

  if (!eventType) return reject('unknown-event');
  if (!eventId) return reject('missing-event-id');
  if (STALE_SOURCES.includes(source)) return reject('stale-source');
  if (!LIVE_SOURCES.includes(source)) return reject('unknown-source');
  if (isSeen(eventId)) return reject('duplicate');
  // `preferences.enabled` is the PUSH toggle. In-app signals must keep working
  // when push is off (`inAppSound` alone is a valid configuration).
  if (preferences.events && preferences.events[eventType] === false) return reject('event-disabled');
  if (input.quietActive === true) return reject('quiet-hours');
  if (input.chatMuted === true) return reject('chat-muted');
  // The live foreground card owns the signal; the SW owns background.
  if (!foreground && source === 'live') return reject('background');
  if (!profile.inAppVibrate && !profile.inAppSound) return reject('disabled');

  const wantsVibrate = !!profile.inAppVibrate && profile.vibratePreset !== 'off' && vibrateSupported;
  const wantsSound = !!profile.inAppSound && soundSupported;
  if (!wantsVibrate && !wantsSound) return reject('unsupported');

  return {
    emit: true,
    vibrate: wantsVibrate,
    sound: wantsSound,
    reason: '',
    eventType,
    eventId,
  };
}

/**
 * Synchronous, cross-tab eventId claim store.
 *
 * The primary backend is `localStorage` (shared and synchronous across tabs),
 * with an in-memory mirror so a tab with storage disabled still dedupes its own
 * events. `claim()` returns true only for the first caller of an eventId.
 *
 * @param {{
 *   storage?: { getItem?: (k: string) => unknown, setItem?: (k: string, v: string) => void, removeItem?: (k: string) => void } | null,
 *   prefix?: string,
 *   ttlMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createEventIdClaimStore(options = {}) {
  const storage = options.storage !== undefined
    ? options.storage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  const prefix = typeof options.prefix === 'string' && options.prefix ? options.prefix : IN_APP_SIGNAL_CLAIM_PREFIX;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? Number(options.ttlMs)
    : IN_APP_SIGNAL_CLAIM_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  /** @type {Map<string, number>} */
  const memory = new Map();
  /** Unique per store so a read-back can tell who wrote last. */
  const cardToken = `${Math.random().toString(36).slice(2)}-${now()}`;

  function readStorage(id) {
    if (!storage || typeof storage.getItem !== 'function') return -1;
    try {
      const raw = storage.getItem(prefix + id);
      if (raw === null || raw === undefined || raw === '') return -1;
      let at = Number(raw);
      if (!Number.isFinite(at)) {
        // Current format is JSON { at, token }; accept a legacy numeric value too.
        try {
          const parsed = JSON.parse(String(raw));
          at = Number(parsed && parsed.at);
        } catch (_) {
          at = NaN;
        }
      }
      return Number.isFinite(at) ? at : -1;
    } catch (_) {
      return -1;
    }
  }

  function lastClaimAt(id) {
    const inMemory = memory.has(id) ? memory.get(id) : -1;
    return Math.max(inMemory, readStorage(id));
  }

  function isClaimed(id) {
    if (!id) return false;
    const at = lastClaimAt(id);
    return at >= 0 && now() - at < ttlMs;
  }

  function writeRecord(id, at, token) {
    memory.set(id, at);
    if (storage && typeof storage.setItem === 'function') {
      try {
        storage.setItem(prefix + id, JSON.stringify({ at, token }));
        return true;
      } catch (_) {
        // Storage full/denied: the in-memory claim still dedupes this tab.
      }
    }
    return false;
  }

  function claim(id) {
    if (!id || isClaimed(id)) return false;
    const at = now();
    const token = `${cardToken}-${at}`;
    const persisted = writeRecord(id, at, token);
    if (persisted) {
      // Read-back makes concurrent claims last-writer-wins: only the writer
      // whose token is still stored may emit; the loser must stay silent.
      let storedToken = '';
      try {
        const parsed = JSON.parse(String(storage.getItem(prefix + id)));
        storedToken = parsed && typeof parsed.token === 'string' ? parsed.token : '';
      } catch (_) {
        storedToken = '';
      }
      if (storedToken && storedToken !== token) {
        memory.delete(id);
        return false;
      }
    }
    return true;
  }

  /** Mark an eventId as seen without playing it (e.g. another card claimed it). */
  function markSeen(id) {
    if (!id) return false;
    writeRecord(id, now(), 'seen');
    return true;
  }

  function forget(id) {
    memory.delete(id);
    if (storage && typeof storage.removeItem === 'function') {
      try {
        storage.removeItem(prefix + id);
      } catch (_) {}
    }
  }

  return { claim, isClaimed, markSeen, forget, prefix, ttlMs };
}

/**
 * Browser player for vibration/sound with injected globals.
 *
 * @param {{
 *   navigator?: unknown,
 *   AudioContext?: unknown,
 *   setTimeout?: (fn: Function, ms?: number) => unknown,
 *   vibratePattern?: number[],
 * }} [deps]
 */
export function createInAppSignalPlayer(deps = {}) {
  const nav = deps.navigator !== undefined
    ? deps.navigator
    : (typeof navigator !== 'undefined' ? navigator : null);
  const AudioCtor = deps.AudioContext !== undefined
    ? deps.AudioContext
    : (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null);
  const pattern = Array.isArray(deps.vibratePattern) && deps.vibratePattern.length
    ? deps.vibratePattern.slice()
    : IN_APP_SIGNAL_VIBRATE_PATTERN.slice();

  /** @type {any} */
  let context = null;
  let unlocked = false;
  let lastError = '';

  function isVibrationSupported() {
    return !!(nav && typeof nav.vibrate === 'function');
  }

  function isSoundSupported() {
    return typeof AudioCtor === 'function';
  }

  /**
   * Create/resume the AudioContext. Must be called from (or after) a user
   * gesture on browsers that block autoplay.
   */
  async function ensureUnlocked() {
    if (!isSoundSupported()) return { ok: false, reason: 'unsupported' };
    try {
      if (!context) context = new AudioCtor();
      if (context && context.state === 'suspended' && typeof context.resume === 'function') {
        await context.resume();
      }
    } catch (err) {
      lastError = String(err?.message || err);
      unlocked = false;
      return { ok: false, reason: 'blocked', detail: lastError };
    }
    unlocked = !!context && (context.state === 'running' || context.state === 'interrupted');
    return unlocked
      ? { ok: true, reason: '' }
      : { ok: false, reason: (context && context.state) || 'blocked' };
  }

  function vibrate(customPattern) {
    if (!isVibrationSupported()) return { ok: false, reason: 'unsupported' };
    const values = Array.isArray(customPattern) && customPattern.length ? customPattern : pattern;
    try {
      const accepted = nav.vibrate(Array.from(values));
      return accepted === false
        ? { ok: false, reason: 'blocked' }
        : { ok: true, reason: '' };
    } catch (err) {
      lastError = String(err?.message || err);
      return { ok: false, reason: 'failed', detail: lastError };
    }
  }

  async function playSound(options = {}) {
    if (!isSoundSupported()) return { ok: false, reason: 'unsupported' };
    const unlock = await ensureUnlocked();
    if (!unlock.ok) return unlock;
    try {
      const preset = NOTIFICATION_SOUND_PRESETS[options.soundPreset] || NOTIFICATION_SOUND_PRESETS.default;
      for (let index = 0; index < preset.pulses; index += 1) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = Number.isFinite(options.frequency) ? Number(options.frequency) : preset.frequency;
        const gainValue = Number.isFinite(options.gain) ? Number(options.gain) : IN_APP_SIGNAL_TONE.gain;
        const durationMs = Number.isFinite(options.durationMs) ? Number(options.durationMs) : preset.durationMs;
        const startAt = context.currentTime + index * (durationMs + 80) / 1000;
        const stopAt = startAt + durationMs / 1000;
        gain.gain.value = gainValue;
        // Fade the tone to avoid a click when the oscillator stops.
        gain.gain.setValueAtTime?.(gainValue, startAt);
        gain.gain.exponentialRampToValueAtTime?.(0.0001, stopAt);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect?.(); gain.disconnect?.(); };
        oscillator.start(startAt);
        oscillator.stop(stopAt);
      }
      return { ok: true, reason: '' };
    } catch (err) {
      lastError = String(err?.message || err);
      return { ok: false, reason: 'failed', detail: lastError };
    }
  }

  function getState() {
    return {
      vibrateSupported: isVibrationSupported(),
      soundSupported: isSoundSupported(),
      unlocked,
      blocked: !!lastError && !unlocked,
      error: lastError,
    };
  }

  return { isVibrationSupported, isSoundSupported, ensureUnlocked, vibrate, playSound, getState };
}

/**
 * Signal controller: dedupe (cross-tab), foreground policy and player calls.
 *
 * @param {{
 *   player?: ReturnType<typeof createInAppSignalPlayer>,
 *   claimStore?: ReturnType<typeof createEventIdClaimStore>,
 *   preferences?: unknown,
 *   foregroundProvider?: () => boolean,
 *   storage?: unknown,
 *   now?: () => number,
 *   volume?: number,
 *   quietHours?: unknown,
 *   chatMuteRecord?: unknown,
 *   chatMuteStore?: { saveRecord?: (record: unknown) => Promise<void>, noteAlert?: Function } | null,
 *   now?: () => number,
 *   logger?: { log?: Function } | null,
 * }} [deps]
 */
export function createInAppSignalController(deps = {}) {
  const player = deps.player || createInAppSignalPlayer(deps);
  const claimStore = deps.claimStore || createEventIdClaimStore({
    storage: deps.storage,
    now: deps.now,
  });
  const foregroundProvider = typeof deps.foregroundProvider === 'function'
    ? deps.foregroundProvider
    : () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden');
  const logger = deps.logger && typeof deps.logger.log === 'function' ? deps.logger : null;
  const channel = deps.broadcastChannel !== undefined
    ? deps.broadcastChannel
    : (typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(IN_APP_SIGNAL_CHANNEL) : null);

  let preferences = normalizePushPreferences(deps.preferences);
  let volume = clampPushInAppVolume(deps.volume === undefined ? PUSH_IN_APP_VOLUME_DEFAULT : deps.volume);
  let quietHours = normalizeQuietHours(deps.quietHours);
  let chatMuteRecord = normalizeChatMuteRecord(deps.chatMuteRecord);
  /** @type {{ saveRecord?: (record: unknown) => Promise<void>, setMuted?: (chatId: string, muted: boolean) => Promise<unknown>, subscribe?: (fn: (record: unknown) => void) => (() => void), noteAlert?: Function } | null} */
  let chatMuteStore = deps.chatMuteStore !== undefined ? deps.chatMuteStore : null;
  /** @type {(() => void) | null} */
  let chatMuteUnsubscribe = null;
  const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;

  function setPreferences(next) {
    preferences = normalizePushPreferences(next);
    return preferences;
  }

  function getPreferences() {
    return preferences;
  }

  function setVolume(next) {
    volume = clampPushInAppVolume(next);
    return volume;
  }

  function setQuietHours(next) {
    quietHours = normalizeQuietHours(next);
    return quietHours;
  }

  function getQuietHours() {
    return quietHours;
  }

  function isQuietActive(clock) {
    return isQuietHoursActive(clock, quietHours);
  }

  function setChatMuteRecord(next) {
    chatMuteRecord = normalizeChatMuteRecord(next);
    return chatMuteRecord;
  }

  function getChatMuteRecord() {
    return chatMuteRecord;
  }

  function isChatMutedLocal(chatId) {
    return isChatMuted(chatMuteRecord, chatId);
  }

  function setChatMuteStore(store) {
    if (chatMuteUnsubscribe) {
      try {
        chatMuteUnsubscribe();
      } catch (_) {}
      chatMuteUnsubscribe = null;
    }
    chatMuteStore = store || null;
    // Another tab may change the device mute list; keep this card's copy fresh.
    if (chatMuteStore && typeof chatMuteStore.subscribe === 'function') {
      try {
        chatMuteUnsubscribe = chatMuteStore.subscribe((record) => {
          chatMuteRecord = normalizeChatMuteRecord(record);
        });
      } catch (_) {
        chatMuteUnsubscribe = null;
      }
    }
    return chatMuteStore;
  }

  /**
   * @param {unknown} chatId
   * @param {boolean} muted
   */
  async function setChatMutedLocal(chatId, muted) {
    // A store with setMuted does a fresh read-modify-write and broadcasts the
    // change, so a stale card copy cannot erase another tab's mutes.
    if (chatMuteStore && typeof chatMuteStore.setMuted === 'function') {
      try {
        const saved = await chatMuteStore.setMuted(chatId, muted);
        chatMuteRecord = normalizeChatMuteRecord(saved);
        return chatMuteRecord;
      } catch (_) {}
    }
    chatMuteRecord = setChatMuted(chatMuteRecord, chatId, muted);
    if (chatMuteStore && typeof chatMuteStore.saveRecord === 'function') {
      try {
        await chatMuteStore.saveRecord(chatMuteRecord);
      } catch (_) {}
    }
    return chatMuteRecord;
  }

  /**
   * Handle one transport/SW event. Never throws.
   *
   * @param {{ eventType?: unknown, kind?: unknown, eventId?: unknown, chatId?: unknown, notificationScope?: 'chat' | 'subchat', source?: string, foreground?: boolean }} input
   */
  function handleEvent(input = {}) {
    const source = typeof input.source === 'string' && input.source ? input.source : 'live';
    const foreground = input.foreground !== undefined ? !!input.foreground : !!foregroundProvider();
    const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
    const eventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
    const quietActive = isQuietActive();
    const chatMuted = chatId ? isChatMutedLocal(chatId) : false;
    /** @type {ReturnType<typeof normalizeChatMuteRecord> | null} */
    let pendingThrottleRecord = null;
    if (chatId && eventId) {
      const throttle = resolveChatAlertThrottle({
        record: chatMuteRecord,
        chatId,
        eventId,
        now: nowFn(),
        cooldownMs: CHAT_ALERT_COOLDOWN_MS,
      });
      if (!throttle.allow) {
        return {
          emit: false,
          vibrate: false,
          sound: false,
          reason: 'alert-throttled',
          eventType: resolveSignalEventType(input.eventType !== undefined ? input.eventType : input.kind),
          eventId,
        };
      }
      // Commit the series slot ONLY after the page actually emits. Otherwise an
      // event that is disabled/muted/unsupported would consume the slot and a
      // later SW delegation would stay silent with no signal anywhere.
      pendingThrottleRecord = throttle.record;
    }
    const decision = resolveInAppSignalDecision({
      preferences,
      notificationScope: resolveNotificationScope(input),
      eventType: input.eventType !== undefined ? input.eventType : input.kind,
      eventId: input.eventId,
      source,
      foreground,
      quietActive,
      chatMuted,
      isSeen: (id) => claimStore.isClaimed(id),
      vibrateSupported: player.isVibrationSupported(),
      soundSupported: player.isSoundSupported(),
    });
    if (!decision.emit) return decision;

    if (!claimStore.claim(decision.eventId)) {
      return { ...decision, emit: false, vibrate: false, sound: false, reason: 'duplicate' };
    }
    // The page really emits now, so the series slot is committed. Alerts stay
    // in memory only (never persisted) to avoid clobbering the device mute list.
    if (pendingThrottleRecord) {
      chatMuteRecord = pendingThrottleRecord;
    }
    // Best-effort cross-card dedupe for tabs without a shared localStorage.
    if (channel && typeof channel.postMessage === 'function') {
      try {
        channel.postMessage({ type: 'claimed', eventId: decision.eventId });
      } catch (_) {}
    }

    if (decision.vibrate) {
      try {
        player.vibrate(Array.from(resolvePushVibratePattern(resolveNotificationProfile(preferences, input).vibratePreset)));
      } catch (err) {
        logger?.log?.('pwa', 'in-app vibrate failed', { error: String(err?.message || err) });
      }
    }
    if (decision.sound) {
      try {
        const profile = resolveNotificationProfile(preferences, input);
        void Promise.resolve(player.playSound({
          soundPreset: profile.soundPreset,
          gain: (profile.volume ?? volume) * IN_APP_SIGNAL_TONE.gain,
        })).catch(() => {});
      } catch (err) {
        logger?.log?.('pwa', 'in-app sound failed', { error: String(err?.message || err) });
      }
    }
    return decision;
  }

  /**
   * Play the signal for genuinely new notification-centre items.
   *
   * A new notification item is a presentation-layer event, not a run event: it has
   * its own gate (`soundEnabled`, from the notification-centre preferences) and its
   * own dedupe-key namespace, but it reuses the single device player, the device
   * volume and the quiet-hours window.
   *
   * @param {{ ids?: unknown, soundEnabled?: unknown }} input
   * @returns {{ emit: boolean, sound: boolean, reason: string, ids: string[] }}
   */
  function handleNotificationItems(input = {}) {
    const ids = Array.isArray(input.ids)
      ? input.ids.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    if (input.soundEnabled !== true) return { emit: false, sound: false, reason: 'disabled', ids: [] };
    if (ids.length === 0) return { emit: false, sound: false, reason: 'empty', ids: [] };
    if (isQuietActive()) return { emit: false, sound: false, reason: 'quiet-hours', ids: [] };
    if (!player.isSoundSupported()) return { emit: false, sound: false, reason: 'unsupported', ids: [] };
    const claimed = [];
    for (const id of ids) {
      const key = `${NOTIFICATION_SIGNAL_CLAIM_PREFIX}${id}`;
      if (claimStore.isClaimed(key)) continue;
      if (!claimStore.claim(key)) continue;
      claimed.push({ id, key });
    }
    if (claimed.length === 0) return { emit: false, sound: false, reason: 'duplicate', ids: [] };
    const profile = resolveNotificationProfile(preferences, {});
    try {
      void Promise.resolve(player.playSound({
        soundPreset: profile.soundPreset,
        gain: (profile.volume ?? volume) * IN_APP_SIGNAL_TONE.gain,
      })).catch(() => {});
    } catch (err) {
      logger?.log?.('pwa', 'notification centre sound failed', { error: String(err?.message || err) });
      return { emit: false, sound: false, reason: 'error', ids: [] };
    }
    if (channel && typeof channel.postMessage === 'function') {
      for (const entry of claimed) {
        try {
          channel.postMessage({ type: 'claimed', eventId: entry.key });
        } catch (_) {}
      }
    }
    return { emit: true, sound: true, reason: '', ids: claimed.map((entry) => entry.id) };
  }

  /**
   * @param {unknown} data message payload from the Service Worker
   * @param {unknown} [ports] MessageChannel ports; when present the page replies
   *   whether it actually handled the signal so the SW can keep the OS vibration
   *   only when the page stayed silent.
   */
  function handleServiceWorkerMessage(data, ports) {
    if (!data || typeof data !== 'object') return null;
    const record = /** @type {Record<string, unknown>} */ (data);
    if (record.type !== IN_APP_SIGNAL_MESSAGE) return null;
    const result = handleEvent({
      eventType: record.eventType !== undefined ? record.eventType : record.kind,
      eventId: record.eventId,
      chatId: record.chatId,
      notificationScope: record.notificationScope,
      source: 'sw',
      foreground: true,
    });
    replyHandled(ports, result);
    return result;
  }

  function replyHandled(ports, result) {
    const port = Array.isArray(ports) ? ports[0] : null;
    if (!port || typeof port.postMessage !== 'function') return;
    // A deliberate page-side suppression counts as handled: the OS notification
    // must not vibrate a second time for a duplicate, quiet hour, muted chat or
    // a throttled alert series.
    const handled = !!result
      && (result.emit === true || SUPPRESSED_SIGNAL_REASONS.includes(result.reason));
    try {
      port.postMessage({
        type: IN_APP_SIGNAL_HANDLED,
        eventId: result?.eventId || '',
        handled,
      });
    } catch (_) {}
  }

  if (channel && typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', (event) => {
      const data = event?.data;
      if (data && data.type === 'claimed' && typeof data.eventId === 'string') {
        claimStore.markSeen(data.eventId);
      }
    });
  }

  /** Unlock Web Audio from a real user gesture. */
  function noteUserGesture() {
    return player.ensureUnlocked();
  }

  /** Release the cross-card channel (tests / teardown). */
  function dispose() {
    if (chatMuteUnsubscribe) {
      try {
        chatMuteUnsubscribe();
      } catch (_) {}
      chatMuteUnsubscribe = null;
    }
    if (channel && typeof channel.close === 'function') {
      try {
        channel.close();
      } catch (_) {}
    }
  }

  return {
    handleEvent,
    handleNotificationItems,
    handleServiceWorkerMessage,
    noteUserGesture,
    setPreferences,
    getPreferences,
    setVolume,
    setQuietHours,
    getQuietHours,
    isQuietActive,
    setChatMuteRecord,
    getChatMuteRecord,
    isChatMuted: isChatMutedLocal,
    setChatMuted: setChatMutedLocal,
    setChatMuteStore,
    getState: () => player.getState(),
    dispose,
    claimStore,
  };
}

/** @type {ReturnType<typeof createInAppSignalController> | null} */
let defaultController = null;
/** @type {() => void} */
let defaultUnbind = () => {};

/**
 * Browser entry point: create the singleton controller, load preferences and
 * subscribe to SW signals + the first user gesture (audio unlock).
 *
 * @param {{
 *   store?: { load?: (endpoint?: string) => Promise<unknown> } | null,
 *   player?: unknown,
 *   storage?: unknown,
 *   logger?: { log?: Function } | null,
 *   win?: unknown,
 *   navigatorRef?: unknown,
 *   chatMuteStore?: { load?: () => Promise<unknown>, saveRecord?: (record: unknown) => Promise<void> } | null,
 * }} [options]
 */
export function initInAppSignals(options = {}) {
  if (defaultController) return defaultController;
  defaultController = createInAppSignalController({
    player: options.player,
    storage: options.storage,
    logger: options.logger,
    broadcastChannel: options.broadcastChannel,
    chatMuteStore: options.chatMuteStore !== undefined ? options.chatMuteStore : null,
  });

  const win = options.win !== undefined
    ? options.win
    : (typeof window !== 'undefined' ? window : null);
  const nav = options.navigatorRef !== undefined
    ? options.navigatorRef
    : (typeof navigator !== 'undefined' ? navigator : null);

  // Load the preferences for the SAME endpoint the settings panel writes to
  // (endpoint-scoped record when subscribed, device draft otherwise).
  const store = options.store !== undefined
    ? options.store
    : createPushPreferencesStore(createIndexedDbPersistence());
  const resolveEndpoint = typeof options.resolveEndpoint === 'function'
    ? options.resolveEndpoint
    : () => resolvePushEndpoint(nav);
  if (store && typeof store.load === 'function') {
    void Promise.resolve(resolveEndpoint())
      .then((endpoint) => store.load(typeof endpoint === 'string' ? endpoint : ''))
      .then((prefs) => defaultController.setPreferences(prefs))
      .catch(() => {});
    if (typeof store.loadVolume === 'function') {
      void Promise.resolve(store.loadVolume())
        .then((value) => defaultController.setVolume(value))
        .catch(() => {});
    }
    if (typeof store.loadQuietHours === 'function') {
      void Promise.resolve(store.loadQuietHours())
        .then((cfg) => defaultController.setQuietHours(cfg))
        .catch(() => {});
    }
  }

  const chatMuteStore = options.chatMuteStore !== undefined ? options.chatMuteStore : null;
  if (chatMuteStore) {
    defaultController.setChatMuteStore(chatMuteStore);
    if (typeof chatMuteStore.load === 'function') {
      void Promise.resolve(chatMuteStore.load())
        .then((record) => defaultController.setChatMuteRecord(record))
        .catch(() => {});
    }
  }

  // First real gesture unlocks Web Audio for later signals.
  if (win && typeof win.addEventListener === 'function') {
    const unlock = () => {
      void Promise.resolve(defaultController.noteUserGesture()).catch(() => {});
    };
    win.addEventListener('pointerdown', unlock, { once: true, passive: true });
    win.addEventListener('keydown', unlock, { once: true });
    defaultUnbind = () => {
      win.removeEventListener?.('pointerdown', unlock);
      win.removeEventListener?.('keydown', unlock);
    };
  }

  // Background signal delegated by the Service Worker. The MessageChannel port
  // carries the "handled" reply (see handleServiceWorkerMessage).
  if (nav && nav.serviceWorker && typeof nav.serviceWorker.addEventListener === 'function') {
    nav.serviceWorker.addEventListener('message', (event) => {
      try {
        defaultController.handleServiceWorkerMessage(event?.data, event?.ports);
      } catch (_) {}
    });
  }

  return defaultController;
}

/**
 * Resolve the active push subscription endpoint (the key the settings panel
 * uses). Returns '' when there is no subscription, i.e. the device draft key.
 *
 * @param {unknown} nav
 * @returns {Promise<string>}
 */
export async function resolvePushEndpoint(nav) {
  try {
    const sw = nav && nav.serviceWorker;
    if (!sw) return '';
    const registration = typeof sw.getRegistration === 'function'
      ? await sw.getRegistration()
      : (sw.ready ? await sw.ready : null);
    const subscription = registration
      && registration.pushManager
      && typeof registration.pushManager.getSubscription === 'function'
      ? await registration.pushManager.getSubscription()
      : null;
    return subscription && typeof subscription.endpoint === 'string' ? subscription.endpoint : '';
  } catch (_) {
    return '';
  }
}

/** @returns {ReturnType<typeof createInAppSignalController> | null} */
export function getInAppSignalController() {
  return defaultController;
}

/**
 * Reload device quiet hours and chat mute from the preferences store (settings UI).
 *
 * @param {{ loadQuietHours?: () => Promise<unknown>, loadChatMuteRecord?: () => Promise<unknown> } | null} [store]
 */
export async function refreshInAppSignalDeviceSettings(store) {
  if (!defaultController || !store) return;
  if (typeof store.loadQuietHours === 'function') {
    try {
      defaultController.setQuietHours(await store.loadQuietHours());
    } catch (_) {}
  }
  if (typeof store.loadChatMuteRecord === 'function') {
    try {
      defaultController.setChatMuteRecord(await store.loadChatMuteRecord());
    } catch (_) {}
  }
}

/**
 * Fire-and-forget hook used by chatTransport for a LIVE transport event.
 * A no-op (reason `not-initialized`) before `initInAppSignals()` runs. A caller
 * may pass an explicit stale `source` (e.g. `replay`); it is preserved so the
 * decision core rejects it instead of being forced to `live`.
 *
 * @param {{ eventType?: unknown, eventId?: unknown, chatId?: string, notificationScope?: 'chat' | 'subchat', foreground?: boolean, source?: string }} input
 */
export function noteLiveInAppSignal(input = {}) {
  if (!defaultController) return { emit: false, vibrate: false, sound: false, reason: 'not-initialized' };
  try {
    const payload = { ...input };
    if (payload.source === undefined) payload.source = 'live';
    return defaultController.handleEvent(payload);
  } catch (_) {
    return { emit: false, vibrate: false, sound: false, reason: 'error' };
  }
}

/**
 * Fire-and-forget hook for genuinely new notification-centre items.
 * A no-op (reason `not-initialized`) before `initInAppSignals()` runs.
 *
 * @param {{ ids?: unknown, soundEnabled?: unknown }} input
 * @returns {{ emit: boolean, sound: boolean, reason: string, ids: string[] }}
 */
export function noteNotificationCenterSignal(input = {}) {
  if (!defaultController) return { emit: false, sound: false, reason: 'not-initialized', ids: [] };
  try {
    return defaultController.handleNotificationItems(input);
  } catch (_) {
    return { emit: false, sound: false, reason: 'error', ids: [] };
  }
}

/** Test/teardown helper: drop the singleton. */
export function resetInAppSignals() {
  defaultUnbind();
  defaultUnbind = () => {};
  if (defaultController && typeof defaultController.dispose === 'function') {
    defaultController.dispose();
  }
  defaultController = null;
}

/**
 * Resolve the vibration pattern if a caller wants the raw preset mapping.
 * Kept as a thin export so the SW/notification path and in-app path agree.
 *
 * @param {unknown} presetId
 */
export function resolveInAppVibratePattern(presetId) {
  const pattern = resolvePushVibratePattern(presetId);
  return Array.isArray(pattern) && pattern.length ? pattern.slice() : [];
}
