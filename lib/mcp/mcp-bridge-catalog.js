/** Keep the builtin catalog available while independent integrations start or fail. */
export const MCP_BRIDGE_CATALOG_BUDGET_MS = 2000;

export async function collectBridgeCatalog(context, servers, { listTools, budgetMs = MCP_BRIDGE_CATALOG_BUDGET_MS }) {
  const rows = servers.map((server) => ({ server, tools: [], state: 'pending' }));
  // Core failures must remain visible; an external failure must not discard core tools.
  for (const row of rows.filter((item) => item.server.kind === 'builtin-cretli')) {
    row.tools = await listTools(context, row.server.id);
    row.state = 'ready';
  }
  const external = rows.filter((row) => row.server.kind !== 'builtin-cretli');
  const loading = external.map(async (row) => {
    try {
      row.tools = await listTools(context, row.server.id);
      row.state = 'ready';
    } catch {
      // The runtime records the sanitized error for Settings / mcp_status.
      row.state = 'failed';
    }
  });
  let timer;
  try {
    await Promise.race([
      Promise.all(loading),
      new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return {
    rows: rows.filter((row) => row.state === 'ready'),
    pending: rows.some((row) => row.state === 'pending'),
    failedServerIds: rows.filter((row) => row.state === 'failed').map((row) => row.server.id),
  };
}

/** Notify MCP clients when slow integrations finish after the initial catalog. */
export function createBridgeCatalogLoader(fetchCatalog, notifyChanged, { pollMs = 1000, maxRefreshMs = 30000 } = {}) {
  let timer;
  let deadline = 0;
  let fingerprint = '';
  let disposed = false;

  const schedule = () => {
    if (disposed || timer || Date.now() >= deadline) return;
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        const catalog = await fetchCatalog();
        if (disposed) return;
        const next = JSON.stringify(catalog.tools || []);
        if (next !== fingerprint) {
          fingerprint = next;
          notifyChanged();
        }
        if (catalog.pending === true) schedule();
      } catch {
        // Authorization or transport failures must not become a background retry loop.
      }
    }, pollMs);
  };

  return {
    async load() {
      const catalog = await fetchCatalog();
      fingerprint = JSON.stringify(catalog.tools || []);
      deadline = Date.now() + maxRefreshMs;
      if (catalog.pending === true) schedule();
      return Array.isArray(catalog.tools) ? catalog.tools : [];
    },
    /**
     * Re-fetch now (a tool list was refreshed) and send list_changed when it differs.
     * Cached lists are already dropped server-side, so this returns the fresh one.
     */
    async refresh() {
      if (disposed) return;
      const catalog = await fetchCatalog();
      if (disposed) return;
      const next = JSON.stringify(catalog.tools || []);
      if (next !== fingerprint) {
        fingerprint = next;
        notifyChanged();
      }
      if (catalog.pending === true) {
        deadline = Date.now() + maxRefreshMs;
        schedule();
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
