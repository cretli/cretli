/**
 * Boot boundary for the application shell.
 *
 * This module is intentionally side-effect-only so the public entrypoint can
 * remain stable while the shell implementation is migrated incrementally.
 */
import './panelRegistry.js';
import './runtime.js';

