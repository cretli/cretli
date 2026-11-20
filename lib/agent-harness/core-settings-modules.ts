/**
 * Settings modules that are always active, whatever optional harness plugins
 * are loaded. They hold fields owned by core infrastructure rather than by a
 * chat harness (today: the OpenRouter client key). Applied before the backend
 * modules, which keeps the pre-plugin order (OpenRouter patch before OpenCode).
 */

import * as openrouterClientSettings from '../providers/openrouter/openrouter-settings.ts';
import type { HarnessSettingsModule } from './harness-settings-patch.ts';

export const CORE_SETTINGS_MODULES: readonly HarnessSettingsModule[] = Object.freeze([openrouterClientSettings]);
