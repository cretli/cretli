/**
 * Combines per-kind scheduler announcers. Every announcer receives every
 * payload and ignores foreign kinds itself; one that throws never prevents the
 * next one from running (and never reaches the scheduler tick).
 */

/**
 * @param {Array<{ notify?: Function, announceChat?: Function }>} announcers
 * @param {{ log?: Function }} [options]
 * @returns {{ notify: Function, announceChat: Function }}
 */
export function composeAnnouncers(announcers, options = {}) {
  const fanOut = (hook) => async (payload) => {
    for (const announcer of announcers) {
      if (typeof announcer?.[hook] !== 'function') continue;
      try {
        await announcer[hook](payload);
      } catch (err) {
        if (typeof options.log === 'function') {
          options.log(`wakeup-${hook}-failed`, { message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  };
  return { notify: fanOut('notify'), announceChat: fanOut('announceChat') };
}
