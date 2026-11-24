import { sanitizeFleetSummary } from './summary.js';

/** Stateless MCP tools/call; redirects cannot forward a credential to another host. */
export async function requestFleetSummary(entry, signal) {
  const response = await fetch(`${entry.url}/mcp`, {
    method: 'POST', signal, redirect: 'error',
    headers: { Authorization: `Bearer ${entry.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fleet_summary', arguments: {} } }),
  });
  if (!response.ok) throw new Error('fleetPollFailed');
  // Bound untrusted responses, including streamed MCP events.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('fleetPollFailed');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString('utf8');
  const messages = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean).map((data) => JSON.parse(data))
    : [JSON.parse(text)];
  const message = messages.find((item) => item.id === 1);
  if (!message || message.error || message.result?.isError) throw new Error('fleetPollFailed');
  return message.result?.structuredContent ?? JSON.parse(message.result?.content?.find((item) => item.type === 'text')?.text);
}

export class FleetPoller {
  #registry; #request; #jobs = new Map(); #running = false; #onChange;
  constructor(registry, { request = requestFleetSummary, intervalMs = 30000, timeoutMs = 10000, maxBackoffMs = 300000, staleMs = 120000 } = {}) {
    this.#registry = registry; this.#request = request;
    this.intervalMs = intervalMs; this.timeoutMs = timeoutMs;
    this.maxBackoffMs = maxBackoffMs; this.staleMs = staleMs;
    this.#onChange = (id) => { this.#cancel(id); if (this.#running && registry.get(id)) this.#schedule(id, 0); };
  }
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#registry.on('change', this.#onChange);
    for (const { id } of this.#registry.list()) this.#schedule(id, 0);
  }
  stop() {
    this.#running = false;
    this.#registry.off('change', this.#onChange);
    for (const id of this.#jobs.keys()) this.#cancel(id);
  }
  #cancel(id) {
    const job = this.#jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer); clearTimeout(job.timeout);
    job.controller?.abort();
    this.#jobs.delete(id);
  }
  #schedule(id, delay, job = { failures: 0, lastSeen: null, summary: null }) {
    this.#jobs.set(id, job);
    job.timer = setTimeout(() => { void this.#poll(id, job); }, delay);
    job.timer.unref?.();
  }
  async #poll(id, job) {
    const entry = this.#registry.credentials(id);
    if (!entry || !this.#running || this.#jobs.get(id) !== job) return;
    job.controller = new AbortController();
    try {
      const timeout = new Promise((_, reject) => {
        job.timeout = setTimeout(() => { job.controller.abort(); reject(new Error('fleetPollTimeout')); }, this.timeoutMs);
        job.timeout.unref?.();
      });
      const raw = await Promise.race([this.#request(entry, job.controller.signal), timeout]);
      const summary = sanitizeFleetSummary(raw);
      if (this.#jobs.get(id) !== job) return;
      job.summary = summary; job.lastSeen = Date.now(); job.failures = 0;
    } catch {
      // Network errors and remote tool messages can contain credentials: retain none.
      if (this.#jobs.get(id) !== job) return;
      job.failures++;
    } finally { clearTimeout(job.timeout); }
    if (this.#running && this.#jobs.get(id) === job) {
      const delay = Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.min(job.failures, 20));
      this.#schedule(id, delay, job);
    }
  }
  status(id) {
    const job = this.#jobs.get(id);
    const lastSeen = job?.lastSeen ?? null;
    const state = lastSeen === null || Date.now() - lastSeen >= this.staleMs ? 'offline' : job.failures || job.summary?.instance.online === false ? 'stale' : 'online';
    return { state, lastSeen, summary: job?.summary ?? null };
  }
  list() { return this.#registry.list().map((entry) => ({ ...entry, ...this.status(entry.id) })); }
}
