/** Static catalog for GLM models supported by the Z.ai Coding Plan. */

const MODEL_ROWS = Object.freeze([
  Object.freeze({ id: 'glm-5.3', name: 'GLM-5.3', contextWindowTokens: 1_048_576 }),
  Object.freeze({ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindowTokens: 1_048_576 }),
  Object.freeze({ id: 'glm-5.2', name: 'GLM-5.2', contextWindowTokens: 1_048_576 }),
]);

/**
 * @returns {Array<{ value: string, label: string, modelId: string, group: string, provider: string, contextWindowTokens: number }>}
 */
export function listZaiModels() {
  return MODEL_ROWS.map((row) => ({
    value: row.id,
    label: row.name,
    modelId: row.id,
    group: 'Z.AI',
    provider: 'zai',
    contextWindowTokens: row.contextWindowTokens,
  }));
}

/**
 * @returns {string}
 */
export function resolveDefaultZaiModel() {
  return String(process.env.ZAI_DEFAULT_MODEL || 'glm-5.3').trim() || 'glm-5.3';
}
