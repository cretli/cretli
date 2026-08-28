#!/usr/bin/env node
/**
 * Detached helper that starts a new instance only after the old process exits.
 * Env: RESTART_PID, RESTART_CWD, RESTART_REQUEST_ID.
 */

import { appendFileSync, closeSync, mkdirSync, openSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const pid = Number.parseInt(process.env.RESTART_PID || '', 10);
const cwd = path.resolve(process.env.RESTART_CWD || process.cwd());
const requestId = process.env.RESTART_REQUEST_ID || 'unknown';
const logFile = path.join(cwd, 'data', 'server-restart.log');
const STOP_TIMEOUT_MS = 8000;
const FORCE_STOP_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 100;
const RESPONSE_GRACE_MS = 700;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  const line = `[${new Date().toISOString()}] [${requestId}] ${message}\n`;
  try {
    appendFileSync(logFile, line, 'utf8');
  } catch {
    // No safe reporting channel left after the old process is gone.
  }
}

function isProcessRunning(targetPid) {
  try {
    process.kill(targetPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(targetPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(targetPid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isProcessRunning(targetPid);
}

async function stopOldServer() {
  if (!isProcessRunning(pid)) return;
  log(`Sending SIGTERM to PID ${pid}.`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  if (await waitForProcessExit(pid, STOP_TIMEOUT_MS)) return;
  log(`PID ${pid} did not exit in ${STOP_TIMEOUT_MS} ms; sending SIGKILL.`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  await waitForProcessExit(pid, FORCE_STOP_TIMEOUT_MS);
}

function startNewServer() {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, 'a');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npm, ['start'], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.once('error', (err) => log(`Failed to start npm start: ${err.message}`));
  child.unref();
  closeSync(logFd);
  log(`Started npm start, PID ${child.pid || 'unknown'}.`);
}

async function main() {
  if (!Number.isFinite(pid) || pid <= 0) {
    log('Missing or invalid RESTART_PID.');
    process.exitCode = 1;
    return;
  }
  mkdirSync(path.dirname(logFile), { recursive: true });
  log(`Starting restart for PID ${pid}.`);
  await sleep(RESPONSE_GRACE_MS);
  await stopOldServer();
  startNewServer();
}

await main();
