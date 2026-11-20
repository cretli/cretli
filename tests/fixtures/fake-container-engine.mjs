#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const stateFile = process.env.FAKE_CONTAINER_STATE;
const logFile = process.env.FAKE_CONTAINER_LOG;
const state = stateFile ? JSON.parse(readFileSync(stateFile, 'utf8')) : { containers: {} };
const args = process.argv.slice(2);
if (logFile) appendFileSync(logFile, `${JSON.stringify(args)}\n`);

if (process.env.FAKE_CONTAINER_MODE === 'timeout') await new Promise((resolve) => setTimeout(resolve, 5000));

const command = args[0];
if (command === 'version') {
  if (process.env.FAKE_CONTAINER_MODE === 'error') process.exit(42);
  process.stdout.write('fake-engine-1.0\n');
} else if (command === 'create') {
  const name = args[args.indexOf('--name') + 1];
  state.containers[name] = { args, running: false };
  process.stdout.write(`${name}\n`);
} else if (command === 'start') {
  if (process.env.FAKE_CONTAINER_MODE === 'start-error') process.exit(43);
  state.containers[args[1]].running = true;
} else if (command === 'ps') {
  process.stdout.write(Object.keys(state.containers).join('\n'));
} else if (command === 'inspect') {
  const container = state.containers[args.at(-1)];
  const labels = container?.labels || {};
  process.stdout.write(`${labels['cretli.execution.owner-pid'] || ''} ${labels['cretli.execution.owner-start'] || ''}\n`);
} else if (command === 'rm') {
  for (const name of args.slice(2)) delete state.containers[name];
} else if (command === 'exec' || command === 'container') {
  process.stdout.write('ok\n');
}
if (command === 'create') {
  const name = args[args.indexOf('--name') + 1];
  const labels = {};
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--label') {
    const [key, value] = args[i + 1].split('=');
    labels[key] = value;
  }
  state.containers[name].labels = labels;
}
if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
