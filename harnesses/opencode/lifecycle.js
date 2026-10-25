/**
 * Lifecycle entry of the OpenCode plugin: the `processLifecycle` hook alone, so
 * the memory monitor CLI can read it without loading the chat runtime.
 */

import { OPENCODE_PROCESS_LIFECYCLE } from './opencode-process-lifecycle.js';

export default { processLifecycle: OPENCODE_PROCESS_LIFECYCLE };
