/**
 * Composition root of the per-harness Polish i18n packs: merged into the base dictionary by
 * app_front/i18n/pl.js.
 */

import { openrouterPl } from '../../../harnesses/openrouter/openrouter.pl.js';
import { mistralPl } from '../../../harnesses/mistral/mistral.pl.js';
import { zaiPl } from '../../../harnesses/zai/zai.pl.js';
import { mimoPl } from '../../../harnesses/mimo/mimo.pl.js';
import { opencodePl } from '../../../harnesses/opencode/opencode.pl.js';
import { codebuddyPl } from '../../../harnesses/codebuddy/codebuddy.pl.js';
import { deepseekPl } from '../../../harnesses/deepseek/deepseek.pl.js';
import { qwenPl } from '../../../harnesses/qwen/qwen.pl.js';

/** @type {readonly Record<string, unknown>[]} */
export const HARNESS_I18N_PACKS_PL = Object.freeze([
  openrouterPl,
  mistralPl,
  zaiPl,
  mimoPl,
  opencodePl,
  codebuddyPl,
  deepseekPl,
  qwenPl,
]);
