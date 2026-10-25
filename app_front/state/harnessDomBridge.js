import { listHarnessUiMeta } from '../core/harness/harnessUiRegistry.js';

/**
 * Adapt the DOM contract of harness plugins outside this migration's scope.
 * Application consumers subscribe to signals; plugin-owned settings still use
 * their existing window events until those modules are migrated together.
 * @param {EventTarget} target
 * @param {ReturnType<typeof import('./configurationState.js').createConfigurationState>} state
 */
export function bindHarnessDomBridge(target, state) {
  const disposers = [];
  for (const meta of listHarnessUiMeta().filter((meta) => !meta.core)) {
    const onModels = (event) => state.publishModels(meta.id, /** @type {CustomEvent} */ (event).detail ?? undefined);
    const onCredentials = () => state.invalidateCredentials(meta.id);
    const credentialsEvent = `cretli-${meta.id}-key-changed`;
    target.addEventListener(meta.modelsChangedEvent, onModels);
    target.addEventListener(credentialsEvent, onCredentials);
    disposers.push(() => {
      target.removeEventListener(meta.modelsChangedEvent, onModels);
      target.removeEventListener(credentialsEvent, onCredentials);
    });
  }
  return () => disposers.forEach((dispose) => dispose());
}
