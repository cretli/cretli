/**
 * @typedef {Object} TerminalRoutesContext
 * @property {() => boolean} isSessionSyncEnabled
 * @property {Map<string, object>} terminalSessions
 * @property {() => string|null} getLastTerminalSessionId
 * @property {(sessionId: string|null) => void} setLastTerminalSessionId
 */

/**
 * @param {import('express').Express} app
 * @param {TerminalRoutesContext} ctx
 */
export function registerTerminalRoutes(app, ctx) {
  app.get('/api/terminal-session', (_req, res) => {
    if (!ctx.isSessionSyncEnabled()) return res.json({ ok: false });
    const lastId = ctx.getLastTerminalSessionId();
    if (lastId && ctx.terminalSessions.has(lastId)) {
      return res.json({ ok: true, sessionId: lastId });
    }
    const first = ctx.terminalSessions.keys().next();
    if (!first.done) {
      ctx.setLastTerminalSessionId(first.value);
      return res.json({ ok: true, sessionId: first.value });
    }
    ctx.setLastTerminalSessionId(null);
    res.json({ ok: false });
  });
}
