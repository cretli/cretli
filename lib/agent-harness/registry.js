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
    transport: 'mistral',
    label: 'Mistral AI',
    description: 'Mistral AI models with server-side workspace tools via @mistralai/mistralai.',
  },
  {
    transport: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode agent harness (tools, LSP, sessions) via @opencode-ai/sdk.',
  },
  {
    transport: 'codebuddy',
    label: 'CodeBuddy',
    description: 'Tencent CodeBuddy Agent SDK (@tencent-ai/agent-sdk) plus the codebuddy CLI.',
  },
  {
    transport: 'deepseek',
    label: 'DeepSeek Harness',
    description: 'DeepSeek Harness (dsh --profile sdk) via @deepseek-ai/dsh-sdk-client.',
  },
  {
    transport: 'codex',
    label: 'Codex SDK',
    description: 'OpenAI Codex local agent (@openai/codex-sdk) plus the bundled Codex CLI.',
  },
  {
    transport: 'qwen',
    label: 'Qwen Code',
    description: 'Qwen Code SDK (@qwen-code/sdk) with a Qwen Cloud API key.',
  },
  {
    transport: 'claude',
    label: 'Claude Code',
    description: 'Claude Agent SDK with an Anthropic API key or an explicitly selected local Claude Code plan login.',
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
