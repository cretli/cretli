/**
 * Composition root of the per-harness English i18n packs: merged into the base dictionary by
 * app_front/i18n/en.js.
 */

import { openrouterEn } from '../../../harnesses/openrouter/openrouter.en.js';
import { mistralEn } from '../../../harnesses/mistral/mistral.en.js';
import { zaiEn } from '../../../harnesses/zai/zai.en.js';
import { mimoEn } from '../../../harnesses/mimo/mimo.en.js';
import { opencodeEn } from '../../../harnesses/opencode/opencode.en.js';
import { codebuddyEn } from '../../../harnesses/codebuddy/codebuddy.en.js';
import { deepseekEn } from '../../../harnesses/deepseek/deepseek.en.js';
import { qwenEn } from '../../../harnesses/qwen/qwen.en.js';

/** @type {readonly Record<string, unknown>[]} */
export const HARNESS_I18N_PACKS_EN = Object.freeze([
  openrouterEn,
  mistralEn,
  zaiEn,
  mimoEn,
  opencodeEn,
  codebuddyEn,
  deepseekEn,
  qwenEn,
]);
