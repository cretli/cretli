/** State used to coalesce page-resume notifications. */
export function createResumeState() {
  return {
    timerId: null,
    reason: null,
    firstEventAt: null,
    notification: false,
    forceReconnect: false,
  };
}

