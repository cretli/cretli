import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Build and exercise the isolated candidate; retain diagnostics outside its disposable tree. */
export async function runFrontendSmoke({ candidate, execute = promisify(execFile) }) {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-ui-smoke-'));
  const env = { ...process.env, CRETLI_UI_SMOKE_DIR: artifacts };
  /** @type {[string, string[]][]} */
  const steps = [
    // Use the CLI directly: the workspace watcher lock must not be shared with this tree.
    ['build', ['node_modules/webpack-cli/bin/cli.js', '--config', 'app_front/webpack.prod.js', '--no-watch']],
    ['browser', ['node_modules/playwright/cli.js', 'test', '--config', 'tests/ui-smoke/playwright.config.js']],
  ];
  for (const [stage, args] of steps) {
    try {
      const output = await execute(process.execPath, args, { cwd: candidate, env, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
      fs.writeFileSync(path.join(artifacts, `${stage}.log`), `${output.stdout || ''}\n${output.stderr || ''}`);
    } catch (cause) {
      fs.writeFileSync(path.join(artifacts, `${stage}.log`), `${cause.stdout || ''}\n${cause.stderr || ''}\n${cause.message}`);
      throw Object.assign(new Error(`frontend_${stage}_failed: ${artifacts}`, { cause }), {
        code: `frontend_${stage}_failed`, artifacts,
      });
    }
  }
  fs.rmSync(artifacts, { recursive: true, force: true });
}
