export const EMBED_DEFAULT_PANEL = 'chat';
export const EMBED_ALLOWED_PANELS = Object.freeze(['chat']);

function normalizeTruthyFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function trimParam(params, key) {
  return String(params.get(key) || '').trim();
}

function getParamsFromSearch(search) {
  return new URLSearchParams(search || '');
}

export function resolveEmbedPanel(panelId, fallback = EMBED_DEFAULT_PANEL) {
  if (EMBED_ALLOWED_PANELS.includes(panelId)) return panelId;
  return EMBED_ALLOWED_PANELS.includes(fallback) ? fallback : EMBED_DEFAULT_PANEL;
}

export function parseEmbedModeQuery(search, pathname = '') {
  const params = getParamsFromSearch(search);
  const panel = trimParam(params, 'panel');
  const installationMatch = String(pathname || '').match(/^\/embed\/([^/]+)$/);
  return {
    embedEnabled: normalizeTruthyFlag(params.get('embed')) || !!installationMatch,
    installationId: installationMatch ? installationMatch[1] : '',
    workspaceFile: trimParam(params, 'workspaceFile'),
    workspaceFolder: trimParam(params, 'workspaceFolder'),
    model: trimParam(params, 'model'),
    panel,
    panelResolved: resolveEmbedPanel(panel, EMBED_DEFAULT_PANEL),
    widgetCreatePageChat: normalizeTruthyFlag(params.get('widgetCreatePageChat')),
  };
}

export function getEmbedWorkspaceOverride(search) {
  const { workspaceFile, workspaceFolder } = parseEmbedModeQuery(search);
  if (!workspaceFile && !workspaceFolder) return null;
  return { workspaceFile, workspaceFolder };
}

export function buildEmbedQueryString(config = {}) {
  const params = new URLSearchParams();
  params.set('embed', '1');

  const workspaceFile = String(config.workspaceFile || '').trim();
  const workspaceFolder = String(config.workspaceFolder || '').trim();
  const model = String(config.model || '').trim();
  const panel = resolveEmbedPanel(String(config.panel || '').trim(), '');

  if (workspaceFile) params.set('workspaceFile', workspaceFile);
  if (workspaceFolder) params.set('workspaceFolder', workspaceFolder);
  if (model) params.set('model', model);
  if (panel) params.set('panel', panel);

  const query = params.toString();
  return query ? `?${query}` : '';
}
