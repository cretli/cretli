/**
 * Permission advisor card UI — static contract checks (sdk-rich-view + transport).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import {
  buildOpenCodePermissionAdvisorStatusPayload,
  resolveAdvisorPublicDisplay,
} from '../lib/approval/approval-advisor.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const richView = fs.readFileSync(path.join(projectRoot, 'app_front/lib/sdk-rich-view.js'), 'utf8');
const transport = fs.readFileSync(path.join(projectRoot, 'app_front/features/chat/chatTransport.js'), 'utf8');
const opencodeWs = fs.readFileSync(path.join(projectRoot, 'lib/opencode/opencode-agent-ws.js'), 'utf8');

assert.match(richView, /openCodePermissionAdvisorMetaByRequestId/);
assert.match(richView, /shouldApplyOpenCodeAdvisorStatus/);
assert.match(richView, /renderOpenCodePermissionAdvisorPanel/);
assert.match(richView, /is-advisor-recommend/);
assert.match(richView, /textContent = t\('sdkView\.openCodePermissionAdvisorPanel\.externalReason'/);
assert.match(richView, /isOpenCodePermissionRequestClosed/);
assert.match(richView, /showOpenCodePermissionAdvisorStatus[\s\S]{0,400}isOpenCodePermissionRequestClosed/);
assert.match(richView, /alwaysAvailable === true/);
assert.match(richView, /recommended === 'always' && !alwaysAvailable/);
assert.match(richView, /is-advisor-pick/);
assert.doesNotMatch(richView, /is-advisor-recommend[\s\S]{0,200}\.focus\(/);
assert.doesNotMatch(richView, /applyAdvisorRecommendationHighlight[\s\S]{0,400}\.click\(/);

assert.match(transport, /advisoryAssessment:/);
assert.match(transport, /alwaysAvailable:/);
assert.match(transport, /localRisk:/);
assert.match(transport, /localCategories/);

assert.match(opencodeWs, /buildOpenCodePermissionAdvisorStatusPayload/);
assert.match(opencodeWs, /replayPendingPermissionAdvisorStatus/);
assert.match(opencodeWs, /forgetPermissionAdvisorStatus/);
assert.match(opencodeWs, /removePendingOpenCodePermission/);
assert.match(opencodeWs, /reconcileAdvisorSnapshotsAfterSessionReset/);

assert.match(richView, /OPENCODE_PERMISSION_ADVISOR_META_MAX/);
assert.match(richView, /trimOpenCodePermissionAdvisorMetaMap/);
assert.match(richView, /normalizeAdvisorSkipReason/);
assert.match(richView, /resolveOpenCodePermission[\s\S]{0,200}openCodePermissionAdvisorMetaByRequestId\.delete/);
assert.match(richView, /onStreamReset\(\)[\s\S]{0,200}openCodePermissionAdvisorMetaByRequestId\.clear/);

const display = resolveAdvisorPublicDisplay({ protocol: 'systemone', model: 'jev-latest' });
assert.equal(display.advisorName, 'jev-latest');
assert.equal(display.advisorProtocol, 'systemone');

const fallback = resolveAdvisorPublicDisplay({ protocol: 'systemone', model: '' });
assert.equal(fallback.advisorName, 'System One');

const payload = buildOpenCodePermissionAdvisorStatusPayload({
  requestId: 'perm_test',
  status: 'decided',
  permissionEvent: { saveOptions: ['read.app_js'] },
  approvalAction: { risk: 'low', categories: [] },
  plan: { protocol: 'openai_chat', model: 'gpt-test' },
  advisoryAssessment: {
    role: 'advisory',
    risk: 'medium',
    recommended: 'once',
    reason: '<img onerror=alert(1)>',
    assessmentLimited: false,
  },
});
assert.equal(payload.localRisk, 'low');
assert.equal(payload.alwaysAvailable, true);
assert.equal(payload.advisorName, 'gpt-test');
assert.equal(payload.advisoryAssessment.reason.includes('<img'), true);

const noAlways = buildOpenCodePermissionAdvisorStatusPayload({
  requestId: 'perm_x',
  status: 'decided',
  permissionEvent: { saveOptions: [] },
  approvalAction: { risk: 'high', categories: ['network'] },
  plan: { protocol: 'systemone', model: '' },
});
assert.equal(noAlways.alwaysAvailable, false);

for (const locale of ['en', 'pl']) {
  const dictionary = fs.readFileSync(path.join(projectRoot, `app_front/i18n/${locale}.js`), 'utf8');
  assert.match(dictionary, /openCodePermissionAdvisorPanel:/);
  assert.match(dictionary, /assessmentLimited:/);
  assert.match(dictionary, /\{advisor\}:/);
  assert.match(dictionary, /openCodePermissionAdvisorSkipReason:/);
  assert.match(dictionary, /session_changed:/);
}

/**
 * @returns {string | null}
 */
function resolveChromiumExecutable() {
  const fromEnv = String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/ms-playwright/chromium-*/chrome-linux/chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const p = String(candidate).trim();
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {string} root
 */
async function startStaticModuleServer(root) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? '/tests/permission-advisor-meta-dom-shell.html' : urlPath;
    const filePath = path.join(root, rel.replace(/^\//, ''));
    if (!filePath.startsWith(root) || !existsSync(filePath)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'text/javascript' : ext === '.html' ? 'text/html' : 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

const executablePath = resolveChromiumExecutable();
if (executablePath) {
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const i18nUrl = `${baseUrl}/app_front/i18n/index.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/permission-advisor-meta-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl, i18nUrl }) => {
      const i18n = await import(i18nUrl);
      await i18n.initI18n();
      const viewMod = await import(viewUrl);
      const mount = document.getElementById('mount');
      if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
      const rich = viewMod.createSdkRichView({ id: 'perm-meta-test' }, mount, { appendPlain() {} });
      const requestId = 'perm_late_meta';
      rich.applyEvent({
        type: 'opencode_permission',
        requestId,
        action: 'read',
        resources: [],
      });
      rich.showOpenCodePermissionAdvisorStatus(requestId, { status: 'checking' });
      const bufferedWhilePending = rich.isOpenCodePermissionAdvisorMetaBuffered(requestId);
      rich.resolveOpenCodePermission(requestId);
      rich.showOpenCodePermissionAdvisorStatus(requestId, {
        status: 'decided',
        advisorDecision: 'once',
        localRisk: 'low',
      });
      return {
        bufferedWhilePending,
        metaAfterLateStatus: rich.isOpenCodePermissionAdvisorMetaBuffered(requestId),
      };
    }, { viewUrl, i18nUrl });
    assert.deepEqual(pageErrors, []);
    assert.equal(result.bufferedWhilePending, true, 'status before resolve buffers meta for the card');
    assert.equal(result.metaAfterLateStatus, false, 'late status after resolve must not re-buffer meta');
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
} else {
  console.warn('permission-advisor-card-ui: skipping DOM behavioral test (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
}

console.log('permission-advisor-card-ui.test.js OK');
