/**
 * Application shell entrypoint.
 *
 * Keep the webpack entry small: boot orchestration and panel policy are
 * separate modules, while the runtime module contains the legacy wiring.
 */
import './boot.js';

