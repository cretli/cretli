/**
 * @typedef {Object} LanRoutesContext
 * @property {number} port
 * @property {boolean} useHttps
 * @property {() => string|null} getLanHost
 */

/**
 * @param {import('express').Express} app
 * @param {LanRoutesContext} ctx
 */
export function registerLanRoutes(app, ctx) {
  app.get('/api/lan-url', (_req, res) => {
    const lan = ctx.getLanHost();
    if (!lan) return res.json({ ok: false });
    const protocol = ctx.useHttps ? 'https' : 'http';
    res.json({ ok: true, url: `${protocol}://${lan}:${ctx.port}` });
  });
}
