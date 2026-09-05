/**
 * Preload hook for `node --import`. Applies `.env` then HTTPS defaults before
 * other modules resolve `CRETLI_DATA_DIR` / `USE_HTTPS`.
 */

import { applyCretliBootEnv } from './boot-env.js';

applyCretliBootEnv();
