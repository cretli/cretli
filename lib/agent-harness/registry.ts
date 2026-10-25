import { AGENT_TRANSPORTS, isRegisteredAgentTransportId } from '../agent-transport.js';
import type { AgentHarnessMeta } from './types.ts';

const HARNESS_REGISTRY: readonly AgentHarnessMeta[] = Object.freeze([
  {
    transport: 'sdk',
    label: 'Cursor SDK',
    description: 'Cursor cloud agent with full IDE tooling (@cursor/sdk).',
  },
  {
    transport: 'codex',
    label: 'Codex SDK',
    description: 'OpenAI Codex local agent (@openai/codex-sdk) plus the bundled Codex CLI.',
  },
  {
    transport: 'claude',
    label: 'Claude Code',
    description: 'Claude Agent SDK with an Anthropic API key or an explicitly selected local Claude Code plan login.',
  },
]);

/**
 * Metadata of repo harness plugins, added once at boot by
 * optional-harness-plugins.js. Empty while a plugin is disabled, so a disabled
 * harness is absent from the harness list and the catalog.
 */
const OPTIONAL_HARNESS_META: AgentHarnessMeta[] = [];

/**
 * Add a plugin's metadata. An id that is already listed is refused.
 */
export function registerOptionalHarnessMeta(meta: AgentHarnessMeta): { ok: true } | { ok: false, code: 'id_collision', error: string } {
  if (HARNESS_REGISTRY.some((row) => row.transport === meta.transport)
    || OPTIONAL_HARNESS_META.some((row) => row.transport === meta.transport)) {
    return { ok: false, code: 'id_collision', error: `Harness metadata "${meta.transport}" is already registered` };
  }
  OPTIONAL_HARNESS_META.push(Object.freeze({ ...meta }));
  return { ok: true };
}

/**
 * Side-effect-free collision check used before a multi-registry plugin load.
 */
export function hasHarnessMeta(transport: string): boolean {
  return HARNESS_REGISTRY.some((row) => row.transport === transport)
    || OPTIONAL_HARNESS_META.some((row) => row.transport === transport);
}

/**
 * Built-ins plus loaded plugins, ordered like {@link AGENT_TRANSPORTS} so a
 * plugin that used to be built in keeps its place in the list.
 */
function allHarnessMeta(): AgentHarnessMeta[] {
  const rank = (id: string) => {
    const index = AGENT_TRANSPORTS.indexOf(id);
    return index === -1 ? AGENT_TRANSPORTS.length : index;
  };
  return [...HARNESS_REGISTRY, ...OPTIONAL_HARNESS_META].sort((a, b) => rank(a.transport) - rank(b.transport));
}

export function listHarnesses(): AgentHarnessMeta[] {
  return allHarnessMeta();
}

export function getHarnessMeta(transport: string): AgentHarnessMeta | null {
  const normalized = AGENT_TRANSPORTS.includes(transport) ? transport : 'sdk';
  return allHarnessMeta().find((entry) => entry.transport === normalized) || null;
}

export function isKnownHarness(transport: string): boolean {
  return isRegisteredAgentTransportId(transport);
}
