/** ACP selectors can group choices; authorization always uses the advertised values. */
export function acpConfigChoices(option) {
  return (option?.options || []).flatMap((choice) => Array.isArray(choice.options) ? acpConfigChoices(choice) : [choice]);
}

export async function configureAntigravitySession(connection, sessionId, initial, { model, mode }) {
  let state = initial;
  const selector = (category) => state.configOptions?.find((option) => option.category === category || option.id === category);
  const set = async (option, value) => {
    const updated = await connection.request('session/set_config_option', { sessionId, configId: option.id, value });
    state = { ...state, ...updated };
  };
  const models = selector('model');
  if (model && model !== 'default') {
    if (!models) {
      await connection.request('session/set_model', { sessionId, modelId: model });
    } else {
      const choices = acpConfigChoices(models);
      const direct = choices.find((choice) => choice.value === model);
      const thoughts = acpConfigChoices(selector('thought_level'));
      const variants = choices.flatMap((choice) => thoughts.map((thought) => ({ model: choice.value, thought: thought.value })))
        .filter((choice) => `${choice.model}-${choice.thought}` === model);
      if (!direct && variants.length !== 1) throw new Error(`Antigravity does not advertise model ${model}`);
      const selected = direct ? { model: direct.value } : variants[0];
      await set(models, selected.model);
      if (selected.thought) {
        const thinking = selector('thought_level');
        if (!acpConfigChoices(thinking).some((choice) => choice.value === selected.thought)) throw new Error(`Antigravity does not support the requested thinking level for ${model}`);
        await set(thinking, selected.thought);
      }
    }
  }
  const readOnly = mode === 'plan' || mode === 'ask';
  const modes = selector('mode');
  if (modes) {
    const choices = acpConfigChoices(modes);
    const target = readOnly
      ? choices.find((choice) => choice.value === 'plan')
      : choices.find((choice) => ['default', 'agent', 'code'].includes(choice.value));
    if (!target) throw new Error(`Antigravity does not advertise a native ${readOnly ? 'Plan' : 'Agent'} mode`);
    if (modes.currentValue !== target.value) await set(modes, target.value);
  } else if (readOnly) {
    const plan = state.modes?.availableModes?.find((item) => item.id === 'plan');
    if (!plan) throw new Error('This Antigravity CLI does not advertise a native Plan mode');
    await connection.request('session/set_mode', { sessionId, modeId: plan.id });
  } else if (state.modes?.currentModeId === 'plan') {
    const agent = state.modes.availableModes.find((item) => ['agent', 'default', 'code'].includes(item.id));
    if (!agent) throw new Error('This Antigravity session cannot switch from Plan to Agent');
    await connection.request('session/set_mode', { sessionId, modeId: agent.id });
  }
  return {
    modelId: selector('model')?.currentValue || (model === 'default' ? state.models?.currentModelId || '' : model),
    thinkingLevel: selector('thought_level')?.currentValue || '',
    mode: selector('mode')?.currentValue || mode,
  };
}
