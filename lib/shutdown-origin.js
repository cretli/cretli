import { execFileSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { redactText } from './browser/redaction.js';

const MAX_CMDLINE_LENGTH = 300;
const MAX_ANCESTOR_DEPTH = 10;
const MAX_SUSPECTS = 20;
const MAX_TREE_ENTRIES = 40;
const PS_TIMEOUT_MS = 1000;
// Processes that can plausibly deliver a SIGTERM or relaunch the server.
const SUSPECT_PATTERN = /(?:^|[\s/])(?:kill|pkill|killall|restart[\w.-]*|npm\s+(?:run\s+)?start|systemctl|supervisorctl|pm2|nodemon|earlyoom)(?:\s|$|\.sh)/i;

/**
 * @typedef {{ pid: number, ppid: number, name: string, cmdline: string }} ProcessInfo
 * @typedef {{ listProcesses: () => ProcessInfo[] }} ProcessReader
 */

function sanitizeCommandLine(value) {
  return redactText(String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CMDLINE_LENGTH * 2)).slice(0, MAX_CMDLINE_LENGTH);
}

function readProcessFromProc(processId) {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
    const openIndex = stat.indexOf('(');
    const closeIndex = stat.lastIndexOf(')');
    const name = stat.slice(openIndex + 1, closeIndex);
    const ppid = Number(stat.slice(closeIndex + 2).split(' ')[1]) || 0;
    let cmdline = '';
    try {
      cmdline = readFileSync(`/proc/${processId}/cmdline`, 'utf8').split('\0').join(' ');
    } catch {
      // Kernel threads and exiting processes have no readable cmdline.
    }
    return { pid: processId, ppid, name, cmdline: cmdline || `[${name}]` };
  } catch {
    return null;
  }
}

function listProcessesFromProc() {
  const processIds = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number);
  return processIds.map(readProcessFromProc).filter(Boolean);
}

function listProcessesFromPs() {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  return output.split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), name: match[3], cmdline: match[4] || match[3] };
  }).filter(Boolean);
}

/**
 * Default reader: /proc first, `ps` as a fallback on hosts without procfs.
 * @returns {ProcessReader}
 */
export function createSystemProcessReader() {
  return {
    listProcesses() {
      try {
        return listProcessesFromProc();
      } catch {
        return listProcessesFromPs();
      }
    },
  };
}

function toPublicEntry(info) {
  return {
    pid: info.pid,
    ppid: info.ppid,
    name: String(info.name || '').slice(0, 80),
    cmdline: sanitizeCommandLine(info.cmdline),
  };
}

function collectAncestors(byPid, startPid) {
  const ancestors = [];
  const seen = new Set();
  let current = byPid.get(startPid);
  while (current && current.pid > 0 && !seen.has(current.pid) && ancestors.length < MAX_ANCESTOR_DEPTH) {
    seen.add(current.pid);
    ancestors.push(toPublicEntry(current));
    current = byPid.get(current.ppid);
  }
  return ancestors;
}

/**
 * Builds a best-effort answer to "who sent this shutdown signal". Node does not
 * expose the sender pid, so the snapshot records the parent chain, the siblings
 * under the same parent and every live process whose command line looks like a
 * kill / restart helper at the moment the signal arrived.
 *
 * @param {{ reader?: ProcessReader, selfPid?: number, now?: () => Date }} [options]
 * @returns {object} JSON-serialisable snapshot; never throws.
 */
export function buildShutdownOriginSnapshot({
  reader = createSystemProcessReader(),
  selfPid = process.pid,
  now = () => new Date(),
} = {}) {
  const capturedAt = now().toISOString();
  const selfParentPid = process.ppid;
  let processes;
  try {
    processes = reader.listProcesses();
  } catch (error) {
    return { capturedAt, pid: selfPid, ppid: selfParentPid, error: sanitizeCommandLine(error?.message || error) };
  }
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  const self = byPid.get(selfPid);
  const ppid = self?.ppid ?? selfParentPid;
  const parent = byPid.get(ppid);
  const ancestors = collectAncestors(byPid, ppid);
  const ancestorIds = new Set(ancestors.map((entry) => entry.pid));
  const suspects = processes
    .filter((info) => info.pid !== selfPid && SUSPECT_PATTERN.test(info.cmdline))
    .slice(0, MAX_SUSPECTS)
    .map(toPublicEntry);
  const treeIds = new Set([...ancestorIds, selfPid]);
  const tree = processes
    .filter((info) => treeIds.has(info.pid) || treeIds.has(info.ppid))
    .slice(0, MAX_TREE_ENTRIES)
    .map(toPublicEntry);
  return {
    capturedAt,
    pid: selfPid,
    ppid,
    parent: parent ? toPublicEntry(parent) : { pid: ppid, name: '', cmdline: '' },
    ancestors,
    suspects,
    processTree: tree,
    processCount: processes.length,
    truncated: suspects.length >= MAX_SUSPECTS || tree.length >= MAX_TREE_ENTRIES,
  };
}
