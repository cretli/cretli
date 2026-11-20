import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { buildClaudeQueryOptions } from '../lib/claude/claude-agent-ws.ts';
import { ensureClaudeTranscriptRetention } from '../lib/claude/claude-retention.ts';

after(removeIsolatedDataDir);
// Opt in with the executable shipped by the pinned optional SDK. No real auth is used.
const executable = process.env.CRETLI_TEST_CLAUDE_EXECUTABLE;
test('pinned CLI retention: agent sweeps at 365 days; read-only skips deletion', { skip: !executable, timeout: 120_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cretli-retention-cli-'));
  const server = http.createServer((req, res) => {
    req.resume();
    // Give background cleanup time to run before returning the model response.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    }, 4000);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const name of ['claude-home', 'claude-api-home']) {
      for (const [mode, assignment] of [['agent', ''], ['plan', ''], ['ask', ''], ['agent', 'review']]) {
        const dataDir = path.join(root, `${name}-${mode}-${assignment}`);
        await ensureClaudeTranscriptRetention(365, { dataDir, candidates: [] });
        const home = path.join(dataDir, name);
        const cwd = path.join(dataDir, 'workspace');
        const projects = path.join(home, 'projects', 'fixture');
        await fs.mkdir(cwd);
        await fs.mkdir(projects, { recursive: true });
        const files = [60, 400].map(days => path.join(projects, `00000000-0000-4000-8000-${String(days).padStart(12, '0')}.jsonl`));
        for (const [index, days] of [60, 400].entries()) {
          await fs.writeFile(files[index], '{}\n');
          const old = new Date(Date.now() - days * 86400_000);
          await fs.utimes(files[index], old, old);
        }
        const marker = path.join(home, '.last-cleanup');
        const readOnly = mode !== 'agent' || assignment === 'review';
        // Cover both a missing marker and an old marker across the two auth homes.
        if (readOnly && name === 'claude-api-home') {
          await fs.writeFile(marker, '0');
          await fs.utimes(marker, new Date(0), new Date(0));
        }
        const settingsBefore = await fs.readFile(path.join(home, 'settings.json'), 'utf8');
        const options = buildClaudeQueryOptions({ cwd, delegationAssignment: assignment }, mode);
        assert.equal(options.settings, undefined);
        const debug = path.join(dataDir, 'debug.log');
        const args = ['-p', 'Reply OK', '--output-format', 'json', '--permission-mode', options.permissionMode, '--debug-file', debug];
        // This is the SDK 0.3.300 serialization: absent sources omit the flag.
        if (options.settingSources) args.push('--setting-sources', options.settingSources.join(','));
        const env = {
          PATH: process.env.PATH, HOME: dataDir, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        };
        const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        clearTimeout(timer);
        assert.equal(code, 0, output);
        await fs.stat(files[0]);
        if (readOnly) {
          await fs.stat(files[1]);
          // The scheduler writes its throttle marker even when the retention gate skips.
          await fs.stat(marker);
          assert.equal(await fs.readFile(path.join(home, 'settings.json'), 'utf8'), settingsBefore);
          assert.match(await fs.readFile(debug, 'utf8'), /Skipping retention cleanup: userSettings source is disabled/);
        } else {
          await assert.rejects(fs.stat(files[1]), { code: 'ENOENT' });
          await fs.stat(marker);
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
