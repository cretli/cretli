import { normalizeHarnessPermissionControls } from '../../../lib/approval/harness-permission-controls.js';

/** Load independent panel sections without letting one API failure hide the other. */
export async function loadPermissionPanelState({ harness, getSettings, getPermissionGrants }) {
  const [settings, grants] = await Promise.allSettled([
    Promise.resolve().then(getSettings),
    Promise.resolve().then(getPermissionGrants),
  ]);
  const settingsData = settings.status === 'fulfilled' ? settings.value : null;
  const grantsData = grants.status === 'fulfilled' ? grants.value : null;
  const controlsAvailable = settingsData?.ok === true && Boolean(settingsData.harnessPermissionControls);
  const grantsAvailable = grantsData?.ok === true && Array.isArray(grantsData.grants);
  return {
    controls: controlsAvailable ? normalizeHarnessPermissionControls(settingsData.harnessPermissionControls)[harness || 'opencode'] : null,
    controlsError: controlsAvailable ? '' : settingsData?.ok === true ? 'serverUpdate' : 'load',
    grants: grantsAvailable ? grantsData.grants.filter((grant) => !harness || grant.harness === harness || grant.scope === 'legacy') : [],
    grantsError: grantsAvailable ? '' : 'load',
  };
}
