import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFreePort,
  pollRuntime,
  requestJson,
  spawnIsolatedCretli,
  stopServer,
  waitForOutput,
} from './helpers/delegation-isolated-http.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'e2e-password-phase2b';
const SECRET_PROMPT = 'phase2b-secret-prompt-text-not-for-health';

function writeSeed(dataDir, chats) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({ chats }, null, 2));
}

function makeChat(title, workspaceFolder) {
  fs.mkdirSync(workspaceFolder, { recursive: true });
  return {
    id: crypto.randomUUID(),
    title,
    cursorSessionId: crypto.randomUUID(),
    agentTransport: 'opencode',
    sdkMode: 'agent',
    workspaceFolder,
    model: 'opencode/test',
    createdAt: new Date().toISOString(),
  };
}

async function login(port) {
  const setup = await requestJson({
    port,
    method: 'POST',
    url: '/api/setup',
    body: { password: PASSWORD },
  });
  if (setup.status === 200 && setup.json?.csrfToken) {
    return { cookie: setup.cookie, csrf: setup.json.csrfToken };
  }
  const loginRes = await requestJson({
    port,
    method: 'POST',
    url: '/api/login',
    body: { password: PASSWORD },
  });
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.json));
  return { cookie: loginRes.cookie, csrf: loginRes.json.csrfToken };
}

async function startJob(session, port, chatId, taskText, key) {
  return requestJson({
    port,
    method: 'POST',
    url: `/api/chats/${chatId}/delegations`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {
      sourceKind: 'text',
      taskText,
      executor: { transport: 'opencode', model: 'opencode/test' },
      idempotencyKey: key || crypto.randomUUID(),
    },
  });
}

async function pollJob(session, port, jobId, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await requestJson({
      port,
      method: 'GET',
      url: `/api/delegations/${jobId}?field=summary`,
      cookie: session.cookie,
    });
    if (last.status === 200 && last.json?.delegation && predicate(last.json.delegation)) {
      return last.json.delegation;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for job ${jobId}: ${JSON.stringify(last?.json || last)}`);
}

async function waitForStartingJob(session, port, parentChatId, timeoutMs = 10000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await requestJson({
      port,
      method: 'GET',
      url: '/api/delegations',
      cookie: session.cookie,
    });
    const rows = Array.isArray(last.json?.delegations) ? last.json.delegations : [];
    const starting = rows.find((row) => (
      String(row.status || '') === 'starting'
      && (!parentChatId || String(row.parentChatId || '') === parentChatId)
    ));
    if (starting) return starting;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for starting job: ${JSON.stringify(last?.json || last)}`);
}

function assertNoPromptLeak(payload, secret) {
  const raw = JSON.stringify(payload);
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes('planMarkdown'), false);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-e2e-del-2b-'));
const wsA = path.join(dataDir, 'ws-a');
const wsB = path.join(dataDir, 'ws-b');
const chatA = makeChat('E2E parent A', wsA);
const chatB = makeChat('E2E parent B', wsB);
const chatC = makeChat('E2E parent C', wsA);
writeSeed(dataDir, [chatA, chatB, chatC]);

const children = [];
try {
  const port = await getFreePort();
  const child = spawnIsolatedCretli({ port, dataDir, cwd: projectRoot });
  children.push(child);
  await waitForOutput(child, /Cretli: http:\/\/localhost:/);
  const session = await login(port);
  const health = await pollRuntime({ port, cookie: session.cookie, want: 'ready' });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.runtime.processAlive, true);
  assert.equal(health.json.runtime.workerRunning, true);
  assert.equal(Object.hasOwn(health.json.runtime, 'processAlive'), true);
  assert.equal(Object.hasOwn(health.json.runtime, 'workerRunning'), true);
  assert.equal(health.json.runtime.lifecycle.state, 'ready');
  assert.equal(health.json.runtime.worker.staleTick, false);
  assertNoPromptLeak(health.json.runtime, SECRET_PROMPT);
  assert.equal('report' in health.json.runtime, false);
  assert.equal('prompt' in health.json.runtime, false);

  const started = await startJob(session, port, chatA.id, SECRET_PROMPT);
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  const jobId = started.json.delegation.id;
  await pollJob(session, port, jobId, (row) => row.status === 'running' && String(row.runId || '').trim());

  const waiting1 = await requestJson({
    port,
    method: 'POST',
    url: `/api/test/delegations/${jobId}/event`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: { kind: 'waiting_for_input' },
  });
  assert.equal(waiting1.json.ok, true, JSON.stringify(waiting1.json));
  assert.equal(waiting1.json.delegation.status, 'waiting_for_input');
  const resumed = await requestJson({
    port,
    method: 'POST',
    url: `/api/test/delegations/${jobId}/event`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: { kind: 'running' },
  });
  assert.equal(resumed.json.delegation.status, 'running');
  const waiting2 = await requestJson({
    port,
    method: 'POST',
    url: `/api/test/delegations/${jobId}/event`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: { kind: 'waiting_for_input' },
  });
  assert.equal(waiting2.json.delegation.status, 'waiting_for_input');
  const history = await requestJson({
    port,
    method: 'GET',
    url: `/api/chats/${chatA.id}/history?tail=80`,
    cookie: session.cookie,
  });
  const waitingEvents = (history.json?.events || []).filter((row) => {
    if (row.rec?.variant !== 'delegation') return false;
    const data = JSON.parse(row.rec.payload);
    return data.event === 'waiting_for_input' && data.id === jobId;
  });
  assert.equal(waitingEvents.length >= 2, true, JSON.stringify(waitingEvents.map((row) => row.rec?.payload)));

  const busyParent = await requestJson({
    port,
    method: 'POST',
    url: `/api/test/chats/${chatA.id}/run`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: { prompt: 'parent already working' },
  });
  assert.equal(busyParent.json.ok, true, JSON.stringify(busyParent.json));
  const finished = await requestJson({
    port,
    method: 'POST',
    url: `/api/test/delegations/${jobId}/event`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: { kind: 'finished', status: 'completed', report: 'phase2b report' },
  });
  assert.equal(finished.json.ok, true, JSON.stringify(finished.json));
  const mailboxBusy = await requestJson({
    port,
    method: 'GET',
    url: `/api/test/chats/${chatA.id}/mailbox`,
    cookie: session.cookie,
  });
  const queued = (mailboxBusy.json.messages || []).filter((row) => row.delegationId === jobId);
  assert.equal(queued.length >= 1, true, JSON.stringify(mailboxBusy.json));
  assert.equal(queued.every((row) => row.status !== 'failed'), true);
  await requestJson({
    port,
    method: 'POST',
    url: `/api/test/chats/${chatA.id}/idle`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  await requestJson({
    port,
    method: 'POST',
    url: `/api/test/chats/${chatA.id}/drain-mailbox`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  const mailboxIdle = await requestJson({
    port,
    method: 'GET',
    url: `/api/test/chats/${chatA.id}/mailbox`,
    cookie: session.cookie,
  });
  const delivered = (mailboxIdle.json.messages || []).filter((row) => row.delegationId === jobId);
  assert.equal(delivered.some((row) => row.status === 'delivered'), true, JSON.stringify(mailboxIdle.json));
  const markUncertain = await requestJson({
    port,
    method: 'POST',
    url: `/api/test/delegations/${jobId}/event`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: { kind: 'mailbox_uncertain' },
  });
  assert.equal(markUncertain.json.ok, true, JSON.stringify(markUncertain.json));
  assert.equal(markUncertain.json.delegation.retryableDelivery, true);

  const scopedA = await requestJson({
    port,
    method: 'GET',
    url: `/api/delegations?workspaceFolder=${encodeURIComponent(wsA)}`,
    cookie: session.cookie,
  });
  const foreign = await startJob(session, port, chatB.id, 'foreign workspace job');
  assert.equal(foreign.json.ok, true, JSON.stringify(foreign.json));
  const scopedAAfter = await requestJson({
    port,
    method: 'GET',
    url: `/api/delegations?workspaceFolder=${encodeURIComponent(wsA)}`,
    cookie: session.cookie,
  });
  const scopedB = await requestJson({
    port,
    method: 'GET',
    url: `/api/delegations?workspaceFolder=${encodeURIComponent(wsB)}`,
    cookie: session.cookie,
  });
  assert.equal(scopedA.json.delegations.every((row) => row.parentChatId === chatA.id), true);
  assert.equal(scopedAAfter.json.delegations.every((row) => row.parentChatId === chatA.id), true);
  assert.equal(scopedB.json.delegations.every((row) => row.parentChatId === chatB.id), true);
  assert.equal(scopedB.json.delegations.some((row) => row.id === foreign.json.delegation.id), true);
  assert.equal(scopedAAfter.json.delegations.some((row) => row.id === foreign.json.delegation.id), false);

  const retryDeliveryOnce = await requestJson({
    port,
    method: 'POST',
    url: `/api/delegations/${jobId}/retry-delivery`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {
      mailboxId: markUncertain.json.delegation.retryableMailboxId,
      attemptId: markUncertain.json.delegation.attemptId,
    },
  });
  const retryDeliveryTwice = await requestJson({
    port,
    method: 'POST',
    url: `/api/delegations/${jobId}/retry-delivery`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {
      mailboxId: markUncertain.json.delegation.retryableMailboxId,
      attemptId: markUncertain.json.delegation.attemptId,
    },
  });
  assert.equal(retryDeliveryOnce.json.ok, true);
  assert.equal(retryDeliveryTwice.json.ok, true);
  assert.equal(retryDeliveryOnce.json.retried >= 1, true, JSON.stringify(retryDeliveryOnce.json));
  const retried = await requestJson({
    port,
    method: 'POST',
    url: `/api/delegations/${jobId}/retry`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  assert.equal(retried.json.ok, true, JSON.stringify(retried.json));
  const afterRetry = await pollJob(session, port, jobId, (row) => Number(row.attemptCount) >= 2);
  assert.equal(Number(afterRetry.attemptCount) >= 2, true);

  await requestJson({
    port,
    method: 'POST',
    url: '/api/test/delegations/hang-next-start',
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  const hungCreate = requestJson({
    port,
    method: 'POST',
    url: `/api/chats/${chatC.id}/delegations`,
    cookie: session.cookie,
    csrf: session.csrf,
    timeoutMs: 8000,
    body: {
      sourceKind: 'text',
      taskText: 'sigkill during accept',
      executor: { transport: 'opencode', model: 'opencode/test' },
      idempotencyKey: crypto.randomUUID(),
    },
  }).catch((err) => ({ error: err }));
  const hungJob = await waitForStartingJob(session, port, chatC.id);
  assert.equal(hungJob.status, 'starting');
  assert.equal(String(hungJob.acceptState || '') === 'pending' || hungJob.acceptState === '', true);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  await hungCreate;

  const port2 = await getFreePort();
  const restarted = spawnIsolatedCretli({ port: port2, dataDir, cwd: projectRoot });
  children.push(restarted);
  await waitForOutput(restarted, /Cretli: http:\/\/localhost:/);
  const session2 = await login(port2);
  const health2 = await pollRuntime({ port: port2, cookie: session2.cookie, want: 'ready' });
  assert.equal(health2.json.runtime.processAlive, true);
  assert.equal(health2.json.runtime.workerRunning, true);
  assert.equal(health2.json.runtime.lifecycle.state, 'ready');
  const stats = await requestJson({
    port: port2,
    method: 'GET',
    url: '/api/test/mock-run/stats',
    cookie: session2.cookie,
  });
  const recovered = await requestJson({
    port: port2,
    method: 'GET',
    url: `/api/delegations/${hungJob.id}?field=summary`,
    cookie: session2.cookie,
  });
  assert.equal(recovered.json.ok, true, JSON.stringify(recovered.json));
  assert.equal(recovered.json.delegation.status, 'interrupted');
  assert.equal(Number(recovered.json.delegation.attemptCount) <= 1, true);
  const activeIds = Array.isArray(stats.json?.activeChatIds) ? stats.json.activeChatIds : [];
  assert.equal(activeIds.includes(String(hungJob.childChatId || '')), false);
  const recoveredChildRun = activeIds.filter((id) => String(id) === String(hungJob.childChatId || ''));
  assert.equal(recoveredChildRun.length, 0);
  const sameJobs = await requestJson({
    port: port2,
    method: 'GET',
    url: '/api/delegations',
    cookie: session2.cookie,
  });
  const recoveredRows = (sameJobs.json.delegations || []).filter((row) => row.id === hungJob.id);
  assert.equal(recoveredRows.length, 1);
  await stopServer(restarted, 'SIGTERM');
} finally {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('delegation-phase2b-e2e.test.js OK');
