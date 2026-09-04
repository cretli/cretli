import { buildMdiSubset } from '../scripts/build-mdi-subset.mjs';

/**
 * Rebuilds the icon font subset before compile. Watch runs re-scan sources so a
 * newly added mdi-* class is picked up without restarting webpack. Unchanged
 * icon sets skip writing (see build-mdi-subset.mjs).
 * Webpack CLI cannot `require()` a config that uses top-level await
 * (ERR_REQUIRE_ASYNC_MODULE on Node 22).
 */
export class BuildMdiSubsetPlugin {
  apply(compiler) {
    compiler.hooks.beforeRun.tapPromise('BuildMdiSubsetPlugin', () => buildMdiSubset());
    compiler.hooks.watchRun.tapPromise('BuildMdiSubsetPlugin', () => buildMdiSubset());
  }
}
