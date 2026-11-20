/** MCP operators can propose prompt changes; only Settings can approve them. */

import { proposeMcpOperatorPromptChange } from './mcp-operator-prompt-store.js';
import { validateMcpOperatorInstructionOverride } from './mcp-external-guide.js';

export const MCP_OPERATOR_PROMPT_PROPOSAL_TOOL = Object.freeze({
  name: 'operator_prompt_change_propose',
  description: 'Propose a per-workspace MCP operator instructions or playbook change. The proposal does not become active until a human approves it in Settings → MCP operator.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt_key: { type: 'string', enum: ['common', 'operator', 'playbook'] },
      text: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['prompt_key', 'text', 'reason'],
  },
});

export function callMcpOperatorPromptProposalTool(client, args) {
  const validation = validateMcpOperatorInstructionOverride(client.workspaceFolder, args.prompt_key, args.text);
  if (!validation.ok) throw Object.assign(new Error(validation.error), { code: 'VALIDATION_ERROR' });
  return proposeMcpOperatorPromptChange(client.workspaceFolder, args.prompt_key, args.text, args.reason);
}
