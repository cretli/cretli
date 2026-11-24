import fsDefault from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';

export const MARKER = 'Cretli managed autostart v1';
const shell = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
// systemd expands specifiers even inside quoted arguments.
const unit = (s, command = false) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => command ? '$$' : '$') + '"';
const winArg = (s) => '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const execDefault = promisify(execFile);

export function portResponds(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', (error) => {
      // Fail closed on errors other than a refused connection.
      done(/** @type {NodeJS.ErrnoException} */ (error).code !== 'ECONNREFUSED');
    });
  });
}

/** One injectable interface shared by the CLI and the settings API. */
export function createAutostart({ fs = fsDefault, exec = execDefault, env = process.env,
  platform = process.platform, release = os.release(), home = env.HOME || os.homedir(),
  execPath = process.execPath, root = '', uid = process.getuid?.(), probe = portResponds } = {}) {
  if (!root || !path.isAbsolute(root) || !path.isAbsolute(execPath) || !path.isAbsolute(home)) {
    throw new Error('Absolute repository, Node and home paths are required');
  }
  const safe = (value) => {
    if (/[\r\n\0]/.test(value)) throw new Error('Control characters in autostart paths are not supported');
    return value;
  };
  [root, home, execPath].forEach(safe);
  const run = async (command, args) => {
    try { return await exec(command, args, { encoding: 'utf8', timeout: 10000, env }); }
    catch (error) {
      // Never retain subprocess output, arguments or inherited environment in errors.
      const code = String(error.code ?? error.signal ?? 'unknown');
      throw new Error(`Autostart command ${path.basename(command)} failed (exit ${/^[a-zA-Z0-9_-]+$/.test(code) ? code : 'unknown'}); output suppressed.`);
    }
  };
  const available = async (command, args) => { try { await run(command, args); return true; } catch { return false; } };
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const supervisor = path.join(root, 'scripts/cretli-supervisor.mjs');
  // Deliberately do not copy the login environment (which can contain secrets).
  const searchPath = [...new Set([path.dirname(execPath), ...(env.PREFIX ? [safe(env.PREFIX) + '/bin'] : []), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  const dataDir = env.CRETLI_DATA_DIR ? path.resolve(root, safe(env.CRETLI_DATA_DIR)) : null;
  const variables = { PATH: searchPath, ...(dataDir ? { CRETLI_DATA_DIR: dataDir } : {}) };
  let cached;
  async function generated() {
    if (cached) return cached;
    let kind, file, content, stopCommand, base = home, warnings = [], start = [], enable = [], disable = [];
    if (platform === 'linux' && (env.WSL_DISTRO_NAME || /microsoft/i.test(release))) {
      kind = 'wsl';
      if (!env.WSL_DISTRO_NAME) return unsupported('WSL requires WSL_DISTRO_NAME');
      let appData = env.APPDATA, windowsFile;
      try {
        // Invoke Windows interop directly; nesting cmd.exe inside wsl.exe fails on WSL.
        if (!appData) appData = (await run('cmd.exe', ['/d', '/c', 'echo %APPDATA%'])).stdout.trim();
        safe(appData);
        if (!appData || appData.includes('%')) return unsupported('Cannot resolve Windows APPDATA for the Startup folder');
        if (!appData.startsWith('/')) appData = (await run('wslpath', ['-u', appData])).stdout.trim();
        safe(appData);
        if (!path.isAbsolute(appData)) return unsupported('APPDATA must resolve to an absolute WSL path');
        base = path.join(appData, 'Microsoft/Windows/Start Menu/Programs/Startup');
        file = path.join(base, 'cretli.vbs');
        windowsFile = (await run('wslpath', ['-w', file])).stdout.trim();
        if (!windowsFile) return unsupported('WSL interop: wslpath returned an empty Windows Startup path');
      } catch (error) {
        return unsupported(`WSL interop unavailable: cmd.exe and wslpath are required. ${error.message}`);
      }
      const args = ['-d', safe(env.WSL_DISTRO_NAME), '--cd', root, '--exec', '/usr/bin/env', ...Object.entries(variables).map(([k,v]) => `${k}=${v}`), execPath, supervisor];
      const command = ['wsl.exe', ...args.map(winArg)].join(' ');
      // WScript reads this UTF-8 file as ANSI; reject values it cannot preserve.
      if (Array.from(command + windowsFile + file).some((character) => character.charCodeAt(0) > 127)) return unsupported('WSL autostart requires ASCII paths and distro names because wscript reads the .vbs as ANSI');
      content = `' ${MARKER}\nSet shell = CreateObject("WScript.Shell")\nshell.Run "${command.replaceAll('"', '""')}", 0, False\n`;
      start = [['wscript.exe', [windowsFile]]];
      stopCommand = `${shell(execPath)} ${shell(supervisor)} request-stop`;
      warnings.push(`WSL: no manager restarts the supervisor itself. Stop it with: ${stopCommand}`);
    } else if (platform === 'linux' && (env.TERMUX_VERSION || /com\.termux/.test(env.PREFIX || ''))) {
      kind = 'termux'; file = path.join(home, '.termux/boot/cretli');
      const exports = Object.entries(variables).map(([k,v]) => `export ${k}=${shell(v)}`).join('\n');
      content = `#!${env.PREFIX ? safe(env.PREFIX) + "/bin/sh" : path.join(path.dirname(execPath), "sh")}\n# ${MARKER}\n${exports}\ncommand -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock\ncd ${shell(root)} || exit 1\nexec ${shell(execPath)} ${shell(supervisor)}\n`;
      start = [['sh', ['-c', `nohup sh ${shell(file)} >/dev/null 2>&1 </dev/null &`]]];
      let bootPackage = '';
      try { bootPackage = (await run('pm', ['path', 'com.termux.boot'])).stdout.trim(); } catch {}
      if (!bootPackage) warnings.push('Termux:Boot is missing or could not be verified: install it and open it once before reboot.');
      stopCommand = `${shell(execPath)} ${shell(supervisor)} request-stop`;
      warnings.push(`Termux: no manager restarts the supervisor itself. Stop it with: ${stopCommand}`);
    } else if (platform === 'darwin') {
      kind = 'launchd'; file = path.join(home, 'Library/LaunchAgents/com.cretli.supervisor.plist');
      content = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARKER} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.cretli.supervisor</string>\n<key>ProgramArguments</key><array><string>${xml(execPath)}</string><string>${xml(supervisor)}</string></array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>\n<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>\n</dict></plist>\n`;
      start = [['launchctl', ['bootstrap', `gui/${uid}`, file]]];
    } else if (platform === 'linux' && await available('systemctl', ['--user', 'show-environment'])) {
      kind = 'systemd'; file = path.join(home, '.config/systemd/user/cretli.service');
      content = `# ${MARKER}\n[Unit]\nDescription=Cretli supervisor\nStartLimitBurst=5\nStartLimitIntervalSec=600\n\n[Service]\nType=simple\nWorkingDirectory=${unit(root)}\nExecStart=${unit(execPath, true)} ${unit(supervisor, true)}\n${Object.entries(variables).map(([k,v]) => `Environment=${unit(`${k}=${v}`)}`).join('\n')}\nRestart=always\nRestartSec=10\nKillMode=mixed\nTimeoutStopSec=45\n\n[Install]\nWantedBy=default.target\n`;
      enable = [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', 'cretli.service']]];
      disable = [['systemctl', ['--user', 'disable', 'cretli.service']], ['systemctl', ['--user', 'daemon-reload']]];
      start = [['systemctl', ['--user', 'start', 'cretli.service']]];
      warnings.push('Without --linger, autostart requires login. --linger explicitly permits loginctl enable-linger for this user (policy may refuse it; no sudo).');
    } else return unsupported('Unsupported platform: use Linux with a working user systemd, macOS, WSL2 or Termux. Native Windows is unsupported.');
    cached = { supported: true, platform: kind, file, base: path.resolve(base), content, stopCommand, warnings, start, enable, disable };
    return cached;
  }
  function unsupported(message) { return { supported: false, platform: 'unsupported', message, warnings: [message] }; }
  function existing(spec) {
    const relative = path.relative(spec.base, spec.file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Autostart file must be inside its managed base');
    // The base and its ancestors may legitimately be symlinks (for example /home).
    for (let dir = path.dirname(spec.file); dir !== spec.base && dir !== path.dirname(dir); dir = path.dirname(dir)) {
      try { if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Refusing symlink in autostart directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    // Never follow a symlink when deciding ownership or replacing a file.
    try { if (!fs.lstatSync(spec.file).isFile()) throw new Error('Refusing non-regular autostart file'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return read(spec.file);
  }
  async function status() {
    const spec = await generated();
    if (!spec.supported) return spec;
    const old = existing(spec);
    return { supported: true, platform: spec.platform, file: spec.file, installed: old !== null && old.includes(MARKER), foreign: old !== null && !old.includes(MARKER), warnings: spec.warnings };
  }
  function uninstallActivation(platform, apply, stopCommand) {
    const removal = apply ? 'Autostart removed.' : 'Autostart removal planned (dry-run).';
    const continuing = {
      launchd: `Loaded launchd supervision keeps running with KeepAlive until logout or reboot. Stop it now with: launchctl bootout gui/${uid}/com.cretli.supervisor`,
      systemd: 'Active systemd supervision keeps running until logout (unless linger keeps the user manager running) or reboot. Removing the unit file and daemon-reload do not stop it. Stop it now with: systemctl --user stop cretli.service',
      wsl: `The running WSL supervisor continues until it is stopped or the session ends. Stop it now with: ${stopCommand}`,
      termux: `The running Termux supervisor continues until it is stopped or the session ends. Stop it now with: ${stopCommand}`,
    };
    return `${removal} Running server and supervisor are not stopped. ${continuing[platform]}`;
  }
  async function operate(action, { apply = false, start = false, linger = false } = {}) {
    const spec = await generated();
    if (!spec.supported) return spec;
    if (linger && spec.platform !== 'systemd') throw new Error('--linger is only supported by systemd');
    const old = existing(spec);
    if (old !== null && !old.includes(MARKER)) throw new Error(`Refusing foreign autostart file: ${spec.file}`);
    const installing = action === 'install';
    const changed = installing ? old !== spec.content : old !== null;
    let occupied = false;
    if (installing && start) {
      const dotenv = read(path.join(root, '.env'));
      const sdkEnv = read(path.join(root, '.cretli-sdk.env'));
      const port = Number(env.PORT ?? (sdkEnv ? parseEnv(sdkEnv).PORT : undefined) ?? (dotenv ? parseEnv(dotenv).PORT : undefined) ?? 3011);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
      occupied = await probe(port);
    }
    const commands = installing ? [...spec.enable, ...(linger ? [['loginctl', ['enable-linger']]] : []), ...(start && !occupied ? spec.start : [])] : (old === null ? [] : spec.disable);
    if (apply) {
      // Disable while the unit still exists; a failure must preserve the file.
      if (!installing && old !== null) {
        for (const [command, args] of spec.disable.slice(0, -1)) await run(command, args);
      }
      if (changed) {
        if (installing) {
          fs.mkdirSync(path.dirname(spec.file), { recursive: true });
          fs.writeFileSync(spec.file, spec.content, { mode: 0o700, flag: old === null ? 'wx' : 'w' });
        } else fs.unlinkSync(spec.file);
      }
      const afterWrite = installing ? commands : commands.slice(-1);
      for (const [command, args] of afterWrite) await run(command, args);
    }
    return { supported: true, platform: spec.platform, file: spec.file, content: installing ? spec.content : undefined,
      dryRun: !apply, changed, commands, ...(spec.stopCommand ? { stopCommand: spec.stopCommand } : {}), warnings: spec.warnings,
      activation: installing ? (occupied ? 'Port responds: nothing started; activation at next boot/login.' : start ? 'Explicit --start requested.' : 'Activation at next boot/login; use --apply --start to start explicitly.') : uninstallActivation(spec.platform, apply, spec.stopCommand) };
  }
  return { generated, status, install: (options) => operate('install', options), uninstall: (options) => operate('uninstall', options) };
}
