import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createAutostart, MARKER } from '../lib/autostart/index.js';

function fixture(t, kind, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-autostart-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const env = { HOME: home, APPDATA: path.join(home, 'AppData/Roaming'),
    ...(kind === 'wsl' ? { WSL_DISTRO_NAME: 'Example Linux' } : {}),
    ...(kind === 'termux' ? { TERMUX_VERSION: '1', PREFIX: '/data/data/com.termux/files/usr' } : {}),
    API_KEY: 'never-copy-this-secret', ...overrides.env };
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (command === 'systemctl' && args.includes('disable') && !fs.existsSync(path.join(overrides.home || home, '.config/systemd/user/cretli.service'))) throw Object.assign(new Error('Unit file does not exist'), { code: 1 });
    if (overrides.exec) return overrides.exec(command, args);
    return { stdout: command === 'pm' ? 'package:termux-boot.apk\n' : command === 'wslpath' ? 'C:\\Users\\user\\Startup\\cretli.vbs\n' : '' };
  };
  const adapter = createAutostart({ fs, platform: kind === 'launchd' ? 'darwin' : 'linux',
    release: 'Linux', home, execPath: '/home/user/node install/bin/node', root: '/home/user/my app', uid: 1000,
    probe: async () => false, ...overrides, exec, env });
  return { adapter, home, calls, env };
}

for (const kind of ['systemd', 'launchd', 'wsl', 'termux']) {
  test(`${kind}: dry-run snapshot, idempotency and marked uninstall`, async (t) => {
    const { adapter, home, calls } = fixture(t, kind);
    const result = await adapter.install();
    const normalized = JSON.parse(JSON.stringify(result).replaceAll(home, '/home/user'));
    assert.deepEqual(normalized, JSON.parse(fs.readFileSync(new URL(`./fixtures/autostart/${kind}.json`, import.meta.url), 'utf8')));
    assert.equal(fs.existsSync(result.file), false);
    assert.ok(!result.content.includes('never-copy-this-secret'));
    assert.equal((await adapter.status()).installed, false);
    await adapter.install({ apply: true });
    const before = fs.statSync(result.file).mtimeMs;
    assert.equal((await adapter.status()).installed, true);
    assert.equal((await adapter.install({ apply: true })).changed, false);
    assert.equal(fs.statSync(result.file).mtimeMs, before);
    await adapter.uninstall();
    assert.ok(fs.existsSync(result.file));
    await adapter.uninstall({ apply: true });
    assert.equal(fs.existsSync(result.file), false);
    assert.equal((await adapter.uninstall({ apply: true })).changed, false);
    assert.ok(!calls.some(([, args]) => args.includes('stop') || args.includes('bootout')));
  });
  test(`${kind}: foreign files and symlinks refused without mutation`, async (t) => {
    const { adapter } = fixture(t, kind);
    const { file } = await adapter.generated();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'foreign file');
    assert.equal((await adapter.status()).foreign, true);
    for (const action of ['install', 'uninstall']) {
      await assert.rejects(adapter[action]({ apply: true }), /foreign/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'foreign file');
    }
    fs.unlinkSync(file);
    fs.symlinkSync('/nonexistent-target', file);
    await assert.rejects(adapter.install({ apply: true }), /non-regular/);
  });
  test(`${kind}: explicit start is skipped when port responds`, async (t) => {
    const { adapter, calls } = fixture(t, kind, { probe: async (port) => { assert.equal(port, 3100); return true; }, env: { PORT: '3100' } });
    const result = await adapter.install({ apply: true, start: true });
    assert.match(result.activation, /Port responds/);
    assert.ok(!calls.some(([cmd, args]) => cmd === 'wscript.exe' || cmd === 'sh' || args.includes('bootstrap') || args.includes('start')));
  });
  test(`${kind}: explicit start commands use fake executors only`, async (t) => {
    const { adapter, calls } = fixture(t, kind);
    const result = await adapter.install({ apply: true, start: true });
    assert.ok(result.commands.length);
    for (const command of result.commands) assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(command)));
    assert.match(result.activation, /Explicit/);
  });
}

test('linger is opt-in, data directory is the only optional exported setting', async (t) => {
  const { adapter, calls } = fixture(t, 'systemd', { env: { CRETLI_DATA_DIR: '/home/user/store', SECRET: 'hidden' } });
  const plain = await adapter.install({ apply: true });
  assert.match(plain.content, /CRETLI_DATA_DIR=\/home\/user\/store/);
  assert.ok(!calls.some(([cmd]) => cmd === 'loginctl'));
  await adapter.install({ apply: true, linger: true });
  assert.ok(calls.some(([cmd, args]) => cmd === 'loginctl' && args[0] === 'enable-linger'));
  assert.ok(!plain.content.includes('hidden'));
});

test('WSL precedes systemd; Windows APPDATA and paths with spaces are quoted', async (t) => {
  const { adapter, calls } = fixture(t, 'wsl', { env: { APPDATA: 'C:\\Users\\user\\AppData\\Roaming' },
    exec: async (cmd) => ({ stdout: cmd === 'wslpath' ? '/mnt/c/Users/user/AppData/Roaming\n' : '' }) });
  const spec = await adapter.generated();
  assert.equal(spec.platform, 'wsl');
  assert.match(spec.content, /""\/home\/user\/node install\/bin\/node""/);
  assert.match(spec.content, /""Example Linux""/);
  assert.ok(!calls.some(([cmd]) => cmd === 'systemctl'));
});

test('WSL uses direct cmd.exe stdout with CRLF and ignores UNC warnings', async (t) => {
  const { adapter, calls } = fixture(t, 'wsl', { env: { APPDATA: '' }, exec: async (cmd, args) => {
    if (cmd === 'wsl.exe') throw Object.assign(new Error('execvpe(cmd.exe) failed'), { code: 1 });
    if (cmd === 'cmd.exe') {
      assert.deepEqual(args, ['/d', '/c', 'echo %APPDATA%']);
      return { stdout: 'C:\\Users\\user\\AppData\\Roaming\r\n', stderr: 'UNC paths are not supported' };
    }
    assert.equal(cmd, 'wslpath');
    return { stdout: args[0] === '-u' ? '/mnt/c/Users/user/AppData/Roaming\n' : 'C:\\Users\\user\\Startup\\cretli.vbs\n' };
  } });
  assert.equal((await adapter.status()).platform, 'wsl');
  assert.equal((await adapter.install()).platform, 'wsl');
  assert.ok(calls.some(([cmd]) => cmd === 'cmd.exe'));
  assert.ok(!calls.some(([cmd]) => cmd === 'wsl.exe'));
});

for (const failure of ['cmd.exe', 'wslpath-u', 'wslpath-w']) {
  test(`WSL returns unsupported when interop fails: ${failure}`, async (t) => {
    const { adapter } = fixture(t, 'wsl', { env: { APPDATA: '' }, exec: async (cmd, args) => {
      if (cmd === failure || `${cmd}${args[0]}` === failure) throw Object.assign(new Error('secret subprocess output'), { code: 'ENOENT' });
      return { stdout: cmd === 'cmd.exe' ? 'C:\\Users\\user\\AppData\\Roaming\r\n' : '/mnt/c/Users/user/AppData/Roaming\n' };
    } });
    for (const action of ['status', 'install']) {
      const result = await adapter[action]();
      assert.equal(result.supported, false);
      assert.match(result.message, /WSL interop unavailable/);
      assert.ok(!result.message.includes('secret subprocess output'));
    }
  });
}
test('unsupported platforms and absent Termux:Boot produce clear messages', async (t) => {
  for (const platform of ['win32', 'linux', 'freebsd']) {
    const { adapter } = fixture(t, 'systemd', { platform, exec: async () => { throw new Error('no user manager'); } });
    assert.equal((await adapter.status()).platform, 'unsupported');
    assert.equal((await adapter.install({ apply: true })).supported, false);
  }
  const { adapter } = fixture(t, 'termux', { exec: async () => ({ stdout: '' }) });
  assert.match((await adapter.install()).warnings.join(' '), /Termux:Boot is missing/);
});

test('systemd escaping, parent symlink refusal and input validation', async (t) => {
  const { adapter, home } = fixture(t, 'systemd', { root: '/home/user/my % $ "app' });
  const spec = await adapter.generated();
  assert.match(spec.content, /my %% \$\$/);
  assert.ok(spec.content.includes(MARKER));
  fs.mkdirSync(path.join(home, 'elsewhere'));
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, '.config'));
  await assert.rejects(adapter.install({ apply: true }), /symlink/);
  assert.throws(() => createAutostart({ root: 'relative' }), /Absolute/);
  assert.throws(() => createAutostart({ root: '/home/user/\napp' }), /Control/);
});

test('start checks the same port precedence as the supervisor without exporting secrets', async (t) => {
  for (const [envPort, sdkPort, expected] of [[undefined, '3200', 3200], ['3300', '3200', 3300], [undefined, undefined, 3100]]) {
    const injectedFs = Object.create(fs);
    injectedFs.readFileSync = (file, encoding) => {
      if (file === '/home/user/my app/.env') return 'PORT=3100\nSECRET=dotenv-secret';
      if (file === '/home/user/my app/.cretli-sdk.env') return sdkPort ? `PORT=${sdkPort}\nSECRET=sdk-secret` : '';
      return fs.readFileSync(file, encoding);
    };
    const { adapter } = fixture(t, 'systemd', { fs: injectedFs, env: { PORT: envPort }, probe: async (port) => { assert.equal(port, expected); return true; } });
    const result = await adapter.install({ start: true });
    assert.match(result.activation, /Port responds/);
    assert.ok(!JSON.stringify(result).includes('dotenv-secret'));
    assert.ok(!JSON.stringify(result).includes('sdk-secret'));
  }
});

test('systemd disables before unlink and reloads after unlink', async (t) => {
  let file;
  const order = [];
  const { adapter } = fixture(t, 'systemd', { exec: async (cmd, args) => {
    if (args.includes('disable')) { assert.ok(fs.existsSync(file)); order.push('disable'); }
    if (args.includes('daemon-reload')) { assert.equal(fs.existsSync(file), false); order.push('reload'); }
    return { stdout: '' };
  } });
  ({ file } = await adapter.generated());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, MARKER);
  await adapter.uninstall({ apply: true });
  assert.deepEqual(order, ['disable', 'reload']);
});

test('failed systemd disable preserves unit and reports command and code without output', async (t) => {
  const { adapter, calls } = fixture(t, 'systemd', { exec: async (cmd, args) => {
    if (args.includes('disable')) throw Object.assign(new Error('secret stdout and environment'), { code: 7, stdout: 'secret' });
    return { stdout: '' };
  } });
  const { file } = await adapter.generated();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, MARKER);
  await assert.rejects(adapter.uninstall({ apply: true }), (error) => {
    assert.match(error.message, /systemctl failed \(exit 7\)/);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), MARKER);
  assert.ok(!calls.some(([, args]) => args.includes('daemon-reload')));
});

for (const kind of ['systemd', 'wsl']) {
  test(`${kind}: symlink above managed base is accepted, below it refused`, async (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-autostart-link-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    fs.mkdirSync(path.join(parent, 'real/user'), { recursive: true });
    fs.symlinkSync(path.join(parent, 'real'), path.join(parent, 'linked'));
    const home = path.join(parent, 'linked/user');
    const { adapter } = fixture(t, kind, { home, env: { APPDATA: path.join(home, 'AppData/Roaming') } });
    await adapter.install({ apply: true });
    assert.equal((await adapter.status()).installed, true);
    await adapter.uninstall({ apply: true });
    const { file, base } = await adapter.generated();
    const belowBase = kind === 'wsl' ? file : path.join(base, '.config');
    fs.rmSync(belowBase, { recursive: true, force: true });
    fs.mkdirSync(path.join(parent, 'elsewhere'));
    fs.symlinkSync(path.join(parent, 'elsewhere'), belowBase);
    for (const action of ['status', 'install', 'uninstall']) await assert.rejects(adapter[action]({ apply: true }), /symlink|non-regular/);
    if (kind === 'wsl') assert.ok(fs.lstatSync(file).isSymbolicLink());
    else assert.equal(fs.existsSync(file), false);
  });
}

for (const overrides of [{ root: '/home/user/aplikacja-ą' }, { env: { WSL_DISTRO_NAME: 'Linuks-ą' } }, { execPath: '/home/user/ą/bin/node' }, { env: { CRETLI_DATA_DIR: '/home/user/ą' } }]) {
  test(`WSL refuses non-ASCII VBS values: ${JSON.stringify(overrides)}`, async (t) => {
    const { adapter } = fixture(t, 'wsl', overrides);
    for (const action of ['status', 'install']) {
      const result = await adapter[action]();
      assert.equal(result.supported, false);
      assert.match(result.message, /ASCII paths and distro names/);
    }
  });
}

test('CLI prints failing command and exit code without subprocess output or environment', { skip: process.platform !== 'linux' }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-autostart-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preload = path.join(home, 'fake-exec.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.release = () => 'Linux';
cp.execFile = (command, args, options, callback) => {
  if (command === 'systemctl' && args.includes('show-environment')) callback(null, '', '');
  else callback(Object.assign(new Error('TOP_SECRET subprocess output'), { code: 9, stdout: 'TOP_SECRET', stderr: 'TOP_SECRET' }));
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ['--import', preload, new URL('../scripts/cretli-autostart.mjs', import.meta.url).pathname, 'install', '--apply'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, WSL_DISTRO_NAME: '', TERMUX_VERSION: '', PREFIX: '', TOP_SECRET: 'private-value' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /systemctl failed \(exit 9\)/);
  assert.ok(!result.stderr.includes('TOP_SECRET'));
  assert.ok(!result.stderr.includes('private-value'));
});

for (const kind of ['systemd', 'launchd', 'wsl', 'termux']) {
  test(`${kind}: uninstall explains ongoing supervision without stopping it`, async (t) => {
    const { adapter, calls } = fixture(t, kind);
    const { file } = await adapter.generated();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, MARKER);
    for (const apply of [false, true]) {
      const result = await adapter.uninstall({ apply });
      assert.match(result.activation, /Running server and supervisor are not stopped/);
      if (kind === 'launchd') {
        assert.match(result.activation, /KeepAlive until logout or reboot/);
        assert.ok(result.activation.includes('launchctl bootout gui/1000/com.cretli.supervisor'));
      } else if (kind === 'systemd') {
        assert.match(result.activation, /until logout .*or reboot/);
        assert.match(result.activation, /daemon-reload do not stop it/);
        assert.ok(result.activation.includes('systemctl --user stop cretli.service'));
      } else {
        assert.match(result.activation, /continues until it is stopped or the session ends/);
        assert.ok(result.activation.endsWith(`Stop it now with: ${result.stopCommand}`));
      }
      assert.ok(!result.commands.some(([, args]) => args.includes('bootout') || args.includes('stop')));
      assert.equal(fs.existsSync(file), !apply);
    }
    assert.ok(!calls.some(([, args]) => args.includes('bootout') || args.includes('stop')));
  });
}

for (const kind of ['wsl', 'termux']) {
  test(`${kind}: stopCommand quotes absolute node and supervisor script and request-stop`, async (t) => {
    const { adapter, calls } = fixture(t, kind, { execPath: "/home/o'brien/node install/bin/node", root: "/home/o'brien/my app" });
    const result = await adapter.install();
    assert.equal(result.stopCommand,
      `'/home/o'\\''brien/node install/bin/node' '/home/o'\\''brien/my app/scripts/cretli-supervisor.mjs' request-stop`);
    assert.ok(result.warnings.some((warning) => warning.endsWith(result.stopCommand)));
    // The shell must parse it back into exactly three arguments.
    const parsed = spawnSync('sh', ['-c', `printf '%s\\n' ${result.stopCommand}`], { encoding: 'utf8' });
    assert.deepEqual(parsed.stdout.trim().split('\n'),
      ["/home/o'brien/node install/bin/node", "/home/o'brien/my app/scripts/cretli-supervisor.mjs", 'request-stop']);
    const removed = await adapter.uninstall();
    assert.equal(removed.stopCommand, result.stopCommand);
    assert.ok(removed.activation.endsWith(result.stopCommand));
    assert.ok(!calls.some(([, args]) => args.includes('stop') || args.includes('bootout')));
  });
}

for (const kind of ['systemd', 'launchd']) {
  test(`${kind}: adapter result carries no stopCommand`, async (t) => {
    const { adapter } = fixture(t, kind);
    assert.equal('stopCommand' in await adapter.install(), false);
    assert.equal('stopCommand' in await adapter.uninstall(), false);
  });
}

test('CLI uninstall exposes launchd persistence and exact stop command in dry-run', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-autostart-message-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preload = path.join(home, 'fake-platform.mjs');
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: 'darwin' });
process.getuid = () => 1000;
`);
  const result = spawnSync(process.execPath, ['--import', preload, new URL('../scripts/cretli-autostart.mjs', import.meta.url).pathname, 'uninstall'], {
    encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.match(output.activation, /KeepAlive until logout or reboot/);
  assert.ok(output.activation.includes('launchctl bootout gui/1000/com.cretli.supervisor'));
  assert.deepEqual(output.commands, []);
  assert.equal(fs.existsSync(output.file), false);
});
