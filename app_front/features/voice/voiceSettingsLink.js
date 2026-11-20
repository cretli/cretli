/** Anchor of the "Microphone and sound" block in Settings → Interface → Voice. */
export const VOICE_DIAGNOSTICS_ANCHOR = 'voice-mic-diagnostics';

/**
 * Opens Settings → Voice on the diagnostics block. Car mode is a full-screen
 * layer that sits above the panels, so settings opened "under" it would be
 * invisible: the view is closed first (it also stops the listener and restores
 * the read mode, the same path as the car exit button).
 *
 * @returns {Promise<boolean>}
 */
export async function openMicSettings() {
  try {
    if (typeof document !== 'undefined' && document.querySelector('cr-car-view')) {
      (await import('../car/carService.js')).closeCarView();
    }
    const { getSharedSpaNavigation } = await import('../../app/appShell/spaNavigationBridge.js');
    await /** @type {any} */ (getSharedSpaNavigation())?.navigate(
      { panel: 'settings', settingsTab: 'interface-voice' },
      { explicit: true },
    );
    const anchor = typeof document !== 'undefined' ? document.getElementById(VOICE_DIAGNOSTICS_ANCHOR) : null;
    anchor?.scrollIntoView?.({ block: 'start' });
    return true;
  } catch {
    return false;
  }
}
