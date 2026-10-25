import type { AgentTransport } from '../agent-transport.js';

export type { AgentTransport };

export interface AgentHarnessMeta {
  transport: AgentTransport;
  label: string;
  description: string;
}
