/**
 * HTML view for the @cursor/sdk chat — collapsible tools, Markdown answers, file paths.
 *
 * Thin facade: the implementation lives in `features/chat/history/`.
 */

import { registerPageResumeCleanupHook } from './pageResumeCleanup.js';
import { dismissSdkImageLightboxIfOpen } from '../features/chat/history/services/inlineImages.js';
import '../components/chat/cr-sdk-block.js';
export { createSdkRichView } from '../features/chat/history/index.js';
export { dismissSdkImageLightboxIfOpen };


registerPageResumeCleanupHook(() => (dismissSdkImageLightboxIfOpen() ? 'sdk-lightbox' : undefined));
