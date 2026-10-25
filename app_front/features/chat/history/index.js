import { installViewShell } from './state/viewShell.js';
import { installOpenCodeAdvisor } from './views/openCodeAdvisor.js';
import { installViewScroll } from './services/viewScroll.js';
import { installStreamBlocks } from './services/streamBlocks.js';
import { installStreamOrder } from './services/streamOrder.js';
import { installRunLifecycle } from './services/runLifecycle.js';
import { installToolBlocks } from './views/toolBlocks.js';
import { installMountedWindow } from './services/mountedWindow.js';
import { installUserBlocks } from './views/userBlocks.js';
import { installOpenCodeInteractive } from './views/openCodeInteractive.js';
import { installSdkEventApply } from './services/sdkEventApply.js';
import { installHistoryApply } from './services/historyApply.js';
import { installDelegationCards } from './views/delegationCards.js';
import { installRecoveryWidgets } from './views/recoveryWidgets.js';
import { installRelatedChatCards } from './views/relatedChatCards.js';
import { installHistoryWindow } from './services/historyWindow.js';
import { installViewApiHead } from './services/viewApiHead.js';
import { installViewApiTail } from './services/viewApiTail.js';
import '../../../components/chat/cr-sdk-block.js';
/**
 * Mounts the rich SDK chat view. The view is assembled from the history modules;
 * each module installs its functions on the shared scope `rv` in source order.
 *
 * @param {any} chat
 * @param {HTMLElement} mountEl
 * @param {any} hooks
 */
export function createSdkRichView(chat, mountEl, hooks) {
  /** @type {any} */
  const rv = { chat, mountEl, hooks };
  installViewShell(rv);
  installOpenCodeAdvisor(rv);
  installViewScroll(rv);
  installStreamBlocks(rv);
  installStreamOrder(rv);
  installRunLifecycle(rv);
  installToolBlocks(rv);
  installMountedWindow(rv);
  installUserBlocks(rv);
  installOpenCodeInteractive(rv);
  installSdkEventApply(rv);
  installHistoryApply(rv);
  installDelegationCards(rv);
  installRecoveryWidgets(rv);
  installRelatedChatCards(rv);
  installHistoryWindow(rv);
  installViewApiHead(rv);
  return installViewApiTail(rv);
}
