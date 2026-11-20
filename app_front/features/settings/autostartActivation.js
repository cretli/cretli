export const AUTOSTART_ACTIVATION_KEYS = Object.freeze({
  next_boot: 'settings.autostartNextBoot',
  removed_systemd: 'settings.autostartRemovedSystemd',
  removed_launchd: 'settings.autostartRemovedLaunchd',
  removed_wsl: 'settings.autostartRemovedWsl',
  removed_termux: 'settings.autostartRemovedTermux',
  unsupported: 'settings.autostartUnsupported',
});

export function autostartActivationMessage(data, translate) {
  const key = Object.hasOwn(AUTOSTART_ACTIVATION_KEYS, data.activationCode)
    ? AUTOSTART_ACTIVATION_KEYS[data.activationCode] : 'settings.autostartApplied';
  return [translate(key), data.stopCommand].filter(Boolean).join(' ');
}
