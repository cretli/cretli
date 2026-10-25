/**
 * Quiet hours + chat mute helpers for public/sw.js (classic script, vm-testable).
 */
(function attachQuietHours(root) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var DEFAULT_QUIET_HOURS = Object.freeze({
    schemaVersion: 1,
    enabled: false,
    start: '22:00',
    end: '07:00',
  });

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function parseQuietTime(value) {
    if (typeof value !== 'string') return -1;
    var trimmed = value.trim();
    var match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (!match) return -1;
    var hours = Number(match[1]);
    var minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return -1;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return -1;
    return hours * 60 + minutes;
  }

  function formatQuietTime(minutes) {
    var total = Number(minutes);
    if (!Number.isFinite(total)) return DEFAULT_QUIET_HOURS.start;
    var clamped = ((Math.floor(total) % 1440) + 1440) % 1440;
    var h = Math.floor(clamped / 60);
    var m = clamped % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function normalizeQuietHours(raw) {
    var source = isPlainObject(raw) ? raw : {};
    var enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_QUIET_HOURS.enabled;
    var startParsed = parseQuietTime(source.start);
    var endParsed = parseQuietTime(source.end);
    var start = startParsed >= 0 ? formatQuietTime(startParsed) : DEFAULT_QUIET_HOURS.start;
    var end = endParsed >= 0 ? formatQuietTime(endParsed) : DEFAULT_QUIET_HOURS.end;
    if (enabled && start === end) enabled = false;
    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: enabled,
      start: start,
      end: end,
    };
  }

  function resolveDeviceMinutes(now) {
    var clock = now && typeof now.getHours === 'function' ? now : new Date();
    var hours = Number(clock.getHours());
    var minutes = Number(clock.getMinutes());
    if (!isFinite(hours) || !isFinite(minutes)) return 0;
    return hours * 60 + minutes;
  }

  function isQuietHoursActive(now, quietHours) {
    var cfg = normalizeQuietHours(quietHours);
    if (!cfg.enabled) return false;
    var start = parseQuietTime(cfg.start);
    var end = parseQuietTime(cfg.end);
    if (start < 0 || end < 0 || start === end) return false;
    var nowMinutes = resolveDeviceMinutes(now);
    if (start > end) {
      return nowMinutes >= start || nowMinutes < end;
    }
    return nowMinutes >= start && nowMinutes < end;
  }

  function resolveQuietState(now, quietHours) {
    var cfg = normalizeQuietHours(quietHours);
    var startMinutes = parseQuietTime(cfg.start);
    var endMinutes = parseQuietTime(cfg.end);
    var nowMinutes = resolveDeviceMinutes(now);
    if (!cfg.enabled) {
      return {
        active: false,
        reason: 'disabled',
        nowMinutes: nowMinutes,
        startMinutes: startMinutes >= 0 ? startMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.start),
        endMinutes: endMinutes >= 0 ? endMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.end),
      };
    }
    var active = isQuietHoursActive(now, cfg);
    return {
      active: active,
      reason: active ? 'active' : 'outside',
      nowMinutes: nowMinutes,
      startMinutes: startMinutes >= 0 ? startMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.start),
      endMinutes: endMinutes >= 0 ? endMinutes : parseQuietTime(DEFAULT_QUIET_HOURS.end),
    };
  }

  function normalizeChatId(id) {
    return typeof id === 'string' ? id.trim() : '';
  }

  function normalizeChatMuteRecord(raw) {
    if (Array.isArray(raw)) {
      var mutedList = [];
      for (var i = 0; i < raw.length && mutedList.length < 500; i += 1) {
        var entry = normalizeChatId(raw[i]);
        if (entry) mutedList.push(entry);
      }
      return { schemaVersion: 1, muted: mutedList, alerts: {} };
    }
    var source = isPlainObject(raw) ? raw : {};
    var mutedRaw = Array.isArray(source.muted) ? source.muted : [];
    var muted = [];
    var seen = {};
    for (var j = 0; j < mutedRaw.length && muted.length < 500; j += 1) {
      var chatId = normalizeChatId(mutedRaw[j]);
      if (!chatId || seen[chatId]) continue;
      seen[chatId] = true;
      muted.push(chatId);
    }
    return { schemaVersion: 1, muted: muted, alerts: isPlainObject(source.alerts) ? source.alerts : {} };
  }

  function isChatMuted(record, chatId) {
    var id = normalizeChatId(chatId);
    if (!id) return false;
    var normalized = normalizeChatMuteRecord(record);
    return normalized.muted.indexOf(id) >= 0;
  }

  root.cretliQuietHours = {
    DEFAULT_QUIET_HOURS: DEFAULT_QUIET_HOURS,
    parseQuietTime: parseQuietTime,
    normalizeQuietHours: normalizeQuietHours,
    isQuietHoursActive: isQuietHoursActive,
    resolveQuietState: resolveQuietState,
    isChatMuted: isChatMuted,
    normalizeChatMuteRecord: normalizeChatMuteRecord,
  };
})(typeof self !== 'undefined' ? self : this);
