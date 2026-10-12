/** HTTP routes for the Z.AI SDK harness. */

import { getZaiSdkApiKeyMetaForClient } from '../zai/zai-api-key.js';
import { isZaiSdkAvailable } from '../zai/zai-sdk-runtime.js';
import { listZaiModels, resolveDefaultZaiModel } from '../zai/zai-models.js';

/**
 * @param {import('express').Express} app
 */
export function registerZaiRoutes(app) {
  app.get('/api/zai/status', (_req, res) => {
    const sdkAvailable = isZaiSdkAvailable();
    const keyMeta = getZaiSdkApiKeyMetaForClient();
    return res.json({
      ok: true,
      ready: sdkAvailable && keyMeta.zaiApiKeyEffective,
      sdkAvailable,
      defaultModel: resolveDefaultZaiModel(),
      ...keyMeta,
    });
  });
  app.get('/api/zai/models', (_req, res) => res.json({
    ok: true,
    models: listZaiModels().map(({ value, label, contextWindowTokens }) => ({
      id: value,
      name: label,
      contextWindowTokens,
    })),
    catalog: listZaiModels(),
    chatEnabledModels: listZaiModels().map((row) => row.value),
    defaultModel: resolveDefaultZaiModel(),
    modelsSource: 'fallback',
  }));
}
