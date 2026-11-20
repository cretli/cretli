/**
 * Voice handlers for the reading settings of the `app_settings` tool: TTS engine, voice and speaking rate
 * (complements `set_read_mode`, which only chooses WHEN answers are read).
 *
 * Built from injected dependencies (unit-testable without DOM or storage). All three actions are risk=safe:
 * they only change local UI preferences, are reversible by voice and never touch credentials.
 *
 * Boundaries:
 * - API keys, the LAN / network exposure and authentication are NOT settable here: the registry enum lists only
 *   the three reading actions and an unknown action is refused with that explanation.
 * - A voice must belong to the CURRENT engine (browser voices as installed, OpenAI / Azure from their fixed lists);
 *   a name is matched against that list and never stored when it does not match uniquely.
 * - A rate outside 0.5-2 is refused, not clamped.
 */

import { foldSpoken } from './voiceAppMatch.js';

/** Actions of `app_settings` handled here. */
export const VOICE_READ_SETTING_ACTIONS = Object.freeze(['tts_engine', 'tts_voice', 'read_rate']);

const RATE_STEP = 0.15;
const CANDIDATES_MAX = 6;

/** @type {Record<string, string[]>} */
const ENGINE_ALIASES = {
  browser: ['browser', 'przegladarka', 'przegladarkowy', 'system', 'systemowy', 'wbudowany', 'built in', 'builtin', 'local'],
  openai: ['openai', 'open ai', 'opena'],
  azure: ['azure', 'azur', 'microsoft'],
};
const SLOWER = ['slower', 'slow', 'slow down', 'wolniej', 'wolno', 'wolniejsze'];
const FASTER = ['faster', 'fast', 'speed up', 'szybciej', 'szybko', 'szybsze'];
const NORMAL = ['normal', 'default', 'normalnie', 'normalne', 'domyslne', 'domyslnie', 'reset'];

/**
 * @param {unknown} value spoken or enum engine name
 * @returns {'browser'|'openai'|'azure'|''}
 */
export function resolveVoiceTtsEngine(value) {
  const folded = foldSpoken(value);
  if (!folded) return '';
  for (const [engine, aliases] of Object.entries(ENGINE_ALIASES)) {
    if (aliases.includes(folded)) return /** @type {'browser'|'openai'|'azure'} */ (engine);
  }
  return '';
}

/**
 * @param {unknown} value a number ("1.5", "1,25"), a relative word, or "normal"
 * @param {number} current rate now
 * @param {{ min: number, max: number, normal: number }} range
 * @returns {{ rate: number } | { error: string }}
 */
export function resolveVoiceReadRate(value, current, range) {
  const folded = foldSpoken(value).replace(',', '.');
  if (!folded) return { error: 'Missing rate' };
  const round = (rate) => Math.round(rate * 100) / 100;
  if (NORMAL.includes(folded)) return { rate: range.normal };
  if (SLOWER.includes(folded)) return { rate: round(Math.max(range.min, current - RATE_STEP)) };
  if (FASTER.includes(folded)) return { rate: round(Math.min(range.max, current + RATE_STEP)) };
  const parsed = Number(folded.replace(/^x/, '').replace(/x$/, ''));
  if (!Number.isFinite(parsed) || folded === '') return { error: `Rate must be a number from ${range.min} to ${range.max}, or slower / faster / normal` };
  if (parsed < range.min || parsed > range.max) return { error: `Rate must be between ${range.min} and ${range.max}` };
  return { rate: round(parsed) };
}

/**
 * @param {string[]} voices
 * @param {unknown} spoken
 * @returns {{ match?: string, ambiguous?: string[] }}
 */
export function matchVoiceByName(voices, spoken) {
  const needle = foldSpoken(spoken).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!needle) return {};
  const folded = voices.map((voice) => foldSpoken(voice).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim());
  const exact = folded.flatMap((value, index) => (value === needle ? [index] : []));
  if (exact.length === 1) return { match: voices[exact[0]] };
  const hits = folded.flatMap((value, index) => (value.includes(needle) ? [index] : []));
  if (hits.length === 1) return { match: voices[hits[0]] };
  if (hits.length > 1) return { ambiguous: hits.slice(0, CANDIDATES_MAX).map((index) => voices[index]) };
  return {};
}

/**
 * @typedef {{
 *   getEngine: () => string,
 *   setEngine: (engine: string) => void,
 *   listVoices: (engine: string) => string[],
 *   getVoice: (engine: string) => string,
 *   setVoice: (engine: string, voice: string) => void,
 *   getRate: () => number,
 *   setRate: (rate: number) => void,
 *   rateRange: { min: number, max: number, normal: number },
 * }} ReadSettingsDeps
 */

/**
 * @param {ReadSettingsDeps} deps
 * @returns {{ readSettings: (args: any) => Promise<object> }}
 */
export function createReadSettingsHandlers(deps) {
  return {
    async readSettings(args) {
      const action = String(args?.action || '').trim().toLowerCase();
      if (action === 'tts_engine') {
        const engine = resolveVoiceTtsEngine(args?.value);
        if (!engine) return { ok: false, error: 'Engine must be browser, openai or azure' };
        deps.setEngine(engine);
        return { ok: true, engine, voice: deps.getVoice(engine) || undefined };
      }
      if (action === 'tts_voice') {
        const engine = deps.getEngine();
        const voices = deps.listVoices(engine);
        if (voices.length === 0) return { ok: false, code: 'no_voices', error: `The ${engine} engine has no voices to choose from right now`, engine };
        const result = matchVoiceByName(voices, args?.value);
        if (result.ambiguous) {
          return { ok: false, code: 'ambiguous', needsClarification: true, error: 'Several voices match. Ask which one.', engine, candidates: result.ambiguous };
        }
        if (!result.match) {
          return { ok: false, code: 'not_found', error: `No ${engine} voice has that name. Nothing was changed.`, engine, available: voices.slice(0, CANDIDATES_MAX * 2) };
        }
        deps.setVoice(engine, result.match);
        return { ok: true, engine, voice: result.match };
      }
      if (action === 'read_rate') {
        const outcome = resolveVoiceReadRate(args?.value, deps.getRate(), deps.rateRange);
        if ('error' in outcome) return { ok: false, error: outcome.error };
        deps.setRate(outcome.rate);
        return { ok: true, rate: outcome.rate };
      }
      return { ok: false, error: 'Reading settings are tts_engine, tts_voice and read_rate. Keys, network and authentication cannot be changed by voice.' };
    },
  };
}
