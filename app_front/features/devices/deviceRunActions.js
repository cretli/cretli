/**
 * Starts one run per target with an API client and scope epoch captured by the caller.
 * A workspace switch (epoch change) stops the remaining starts, so a script chosen in one
 * workspace is never sent through another workspace's client.
 * @param {{ api: { startRun: Function }, targets: Array<{ id: string, name: string }>, scriptPath: string, getEpoch: () => number, epoch: number }} input
 * @returns {Promise<{ aborted: boolean, started: string[], errors: Array<{ device: string, code: string }> }>}
 */
export async function startRunsOnTargets({ api, targets, scriptPath, getEpoch, epoch }) {
  const started = [], errors = [];
  for (const d of targets) {
    if (getEpoch() !== epoch) return { aborted: true, started, errors };
    try { await api.startRun(d.id, { scriptPath }); started.push(d.id); }
    catch (err) { errors.push({ device: d.name, code: String(err?.code || '') }); }
  }
  return { aborted: getEpoch() !== epoch, started, errors };
}
