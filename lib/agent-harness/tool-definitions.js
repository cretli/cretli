/**
 * OpenAI-compatible tool schemas for OpenRouter agent harness.
 */

import { resolveHarnessReadOnlyPolicy } from './harness-plan-policy.js';
import { isPlanModeMutatingToolName } from '../sdk/sdk-plan-guard.js';

export const OPENROUTER_AGENT_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace (relative path).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in a workspace folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (empty = workspace root)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a pattern in workspace files using ripgrep or grep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or literal pattern' },
          path: { type: 'string', description: 'Optional relative directory to search' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a text file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description: 'Replace the first occurrence of old_string with new_string in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description: 'Run a shell command in the workspace directory (non-interactive).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status summary for the workspace repository.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff for a file or entire repo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional relative file path' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_run',
      description: 'Run a whitelisted git action (status, fetch, pull, push, log, diff, branch, stash, switch, merge, rebase).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          arg: { type: 'string', description: 'Branch name when required by action' },
        },
        required: ['action'],
      },
    },
  },
]);

const OPENROUTER_MUTATING_TOOL_NAMES = new Set([
  'write_file',
  'search_replace',
  'run_terminal_command',
  'git_run',
]);

/**
 * @param {string} toolName
 * @returns {boolean}
 */
export function isMutatingToolName(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return false;
  if (OPENROUTER_MUTATING_TOOL_NAMES.has(name)) return true;
  return isPlanModeMutatingToolName(name);
}

/**
 * @param {unknown} mode
 * @returns {typeof OPENROUTER_AGENT_TOOLS}
 */
export function getToolsForMode(mode) {
  const policy = resolveHarnessReadOnlyPolicy('openrouter', mode);
  if (policy.denyMutatingTools) {
    return OPENROUTER_AGENT_TOOLS.filter(
      (tool) => !isMutatingToolName(tool.function?.name || ''),
    );
  }
  return OPENROUTER_AGENT_TOOLS;
}
