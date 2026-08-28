import { AGENT_TRANSPORTS } from '../agent-transport.js';

/** @type {import('./types.js').AgentHarnessMeta[]} */
const HARNESS_REGISTRY = Object.freeze([
  {
    transport: 'sdk',
    label: 'Cursor SDK',
    description: 'Cursor cloud agent with full IDE tooling (@cursor/sdk).',
  },
  {
    transport: 'openrouter',
    label: 'OpenRouter',
    description: 'OpenRouter LLM with server-side workspace tools.',
  },
  {
    transport: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode agent harness (tools, LSP, sessions) via @opencode-ai/sdk.',
  },
]);

/**
 * @returns {import('./types.js').AgentHarnessMeta[]}
 */
export function listHarnesses() {
  return HARNESS_REGISTRY.slice();
}

/**
 * @param {string} transport
 * @returns {import('./types.js').AgentHarnessMeta | null}
 */
export function getHarnessMeta(transport) {
  const normalized = AGENT_TRANSPORTS.includes(transport) ? transport : 'sdk';
  return HARNESS_REGISTRY.find((entry) => entry.transport === normalized) || null;
}

/**
 * @param {string} transport
 * @returns {boolean}
 */
export function isKnownHarness(transport) {
  return AGENT_TRANSPORTS.includes(transport);
}
