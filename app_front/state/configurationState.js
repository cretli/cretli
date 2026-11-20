/** Shared configuration state; credential signals contain revisions, never secrets. */
import { signal } from '@lit-labs/signals';
import { subscribe } from './sharedState.js';

export function createConfigurationState() {
  /** @type {Map<string, ReturnType<typeof signal<number>>>} */
  const credentials = new Map();
  /** @type {Map<string, ReturnType<typeof signal<Record<string, any> | null>>>} */
  const models = new Map();
  const enabledHarnesses = signal(/** @type {{ enabledHarnesses: string[], harnessOrder: string[] } | null} */ (null));
  const defaultHarness = signal('');

  function credentialRevision(provider) {
    if (!credentials.has(provider)) credentials.set(provider, signal(0));
    return credentials.get(provider);
  }

  function harnessModels(harness) {
    if (!models.has(harness)) models.set(harness, signal(null));
    return models.get(harness);
  }

  return {
    enabledHarnesses,
    defaultHarness,
    credentialRevision,
    harnessModels,
    invalidateCredentials(provider) {
      const revision = credentialRevision(provider);
      revision.set(revision.get() + 1);
    },
    onCredentialsChanged(provider, listener) {
      return subscribe(credentialRevision(provider), () => listener());
    },
    /**
     * Retain partial catalog/selection updates. A refresh without a payload
     * invalidates the snapshot so consumers cannot reapply an old catalog.
     * @param {string} harness
     * @param {Record<string, any>} [detail]
     */
    publishModels(harness, detail) {
      const source = harnessModels(harness);
      source.set(detail === undefined ? {} : { ...source.get(), ...detail });
    },
    onModelsChanged(harness, listener) {
      return subscribe(harnessModels(harness), listener);
    },
  };
}
