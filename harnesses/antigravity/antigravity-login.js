import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAntigravityCliFound, resolveAntigravityCli } from './antigravity-config.js';

/** Only expose the CLI's Google authorization URL, never its raw output. */
export function parseAntigravityLoginUrl(output) {
  // eslint-disable-next-line no-control-regex
  const text = String(output).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  // eslint-disable-next-line no-control-regex
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\x1b]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname === 'accounts.google.com' && !url.username && !url.password && !url.port
        && /^\/o\/oauth2\//.test(url.pathname)) return url.href;
    } catch { /* Incomplete URLs can arrive split across output chunks. */ }
  }
  return '';
}

/** The official CLI owns OAuth exchange and credential storage. */
export function createAntigravityLoginManager({ spawnProcess = spawn, cliFound = isAntigravityCliFound, resolveCli = resolveAntigravityCli, timeoutMs = 15 * 60 * 1000 } = {}) {
  let attempt = null;
  const state = () => {
    if (!attempt) return { phase: 'idle', attemptId: '', url: '', error: '', startedAt: 0 };
    const { phase, attemptId, error, startedAt } = attempt;
    return { phase, attemptId, error, startedAt, url: phase === 'waiting' ? attempt.url : '' };
  };
  const active = () => attempt && ['starting', 'waiting', 'submitting'].includes(attempt.phase);
  const finish = (current, phase, error = '') => {
    if (current !== attempt || !active()) return;
    current.phase = phase;
    current.error = error;
    current.buffer = '';
    current.url = '';
    clearTimeout(current.timeout);
  };
  const stop = (current) => {
    if (!current?.child) return;
    const child = current.child;
    const kill = (signal) => {
      if (child.exitCode != null) return;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    child.stdin?.destroy();
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1500);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  };
  return {
    state,
    start() {
      if (active()) return { ok: true, login: state() };
      if (!cliFound()) return { ok: false, error: 'Install Antigravity CLI (agy) before signing in.', login: state() };
      const current = { phase: 'starting', attemptId: randomUUID(), error: '', startedAt: Date.now(), url: '', buffer: '', child: null, timeout: null };
      attempt = current;
      try {
        const child = spawnProcess(resolveCli(), ['acp', '--login'], {
          env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
        });
        current.child = child;
        const onChunk = (chunk) => {
          if (current !== attempt || !active() || current.phase === 'submitting') return;
          current.buffer = (current.buffer + String(chunk)).slice(-32768);
          const url = parseAntigravityLoginUrl(current.buffer);
          if (url) { current.url = url; current.phase = 'waiting'; }
        };
        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);
        child.stdin?.on('error', () => {
          finish(current, 'error', 'Could not send the authorization code to Antigravity. Start again.');
          stop(current);
        });
        child.once('error', () => {
          finish(current, 'error', 'Could not start Antigravity login. Check the CLI executable.');
          stop(current);
        });
        child.once('close', (code) => {
          finish(current, code === 0 ? 'completed' : 'error', code === 0 ? '' : 'Antigravity login failed. Start again and use a fresh Google authorization code.');
        });
        current.timeout = setTimeout(() => {
          finish(current, 'error', 'Antigravity login timed out. Start again.');
          stop(current);
        }, timeoutMs);
        current.timeout.unref();
      } catch {
        finish(current, 'error', 'Could not start Antigravity login. Check the CLI executable.');
      }
      return { ok: current.phase !== 'error', login: state(), ...(current.phase === 'error' ? { error: current.error } : {}) };
    },
    complete(attemptId, rawCode) {
      const code = typeof rawCode === 'string' ? rawCode.trim() : '';
      if (!active() || attempt.phase !== 'waiting' || attempt.attemptId !== attemptId) return { ok: false, error: 'This login attempt is no longer waiting for a code. Start again.', login: state() };
      // Authorization codes must be a single terminal input line.
      // eslint-disable-next-line no-control-regex
      if (!code || code.length > 2048 || /[\s\x00-\x1f\x7f]/.test(code)) return { ok: false, error: 'Paste the authorization code shown by Google.', login: state() };
      const current = attempt;
      current.phase = 'submitting';
      current.buffer = '';
      current.url = '';
      try { current.child.stdin.write(code + '\n'); }
      catch { finish(current, 'error', 'Could not send the authorization code. Start again.'); stop(current); }
      return { ok: current.phase !== 'error', login: state() };
    },
    cancel(attemptId) {
      if (active() && attempt.attemptId === attemptId) {
        const current = attempt;
        finish(current, 'cancelled');
        stop(current);
      }
      return { ok: true, login: state() };
    },
  };
}

export const antigravityLogin = createAntigravityLoginManager();

export function registerAntigravityLoginRoutes(app, manager = antigravityLogin) {
  const guard = (handler) => (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    res.set('Cache-Control', 'no-store');
    return handler(req, res);
  };
  app.get('/api/antigravity/login/status', guard((_req, res) => res.json({ ok: true, login: manager.state() })));
  app.post('/api/antigravity/login/start', guard((_req, res) => {
    const result = manager.start();
    return res.status(result.ok ? 200 : 503).json(result);
  }));
  app.post('/api/antigravity/login/complete', guard((req, res) => {
    const result = manager.complete(req.body?.attemptId, req.body?.code);
    return res.status(result.ok ? 200 : 400).json(result);
  }));
  app.post('/api/antigravity/login/cancel', guard((req, res) => res.json(manager.cancel(req.body?.attemptId))));
}
