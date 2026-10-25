/** App-wide shared signal store (see sharedState.js and docs/shared-state.md). */
import { createSharedState } from './sharedState.js';

export const sharedState = createSharedState();
export { subscribe, createSharedState } from './sharedState.js';

import { createChatListRowsState } from './chatListRowsState.js';

/** Slim sidebar rows keyed by chat id (see chatListRowsState.js). */
export const chatListRows = createChatListRowsState();

import { createConfigurationState } from './configurationState.js';
import { bindHarnessDomBridge } from './harnessDomBridge.js';
export const configurationState = createConfigurationState();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  bindHarnessDomBridge(window, configurationState);
}
