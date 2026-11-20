/**
 * Map-reduce context compression via agent --print.
 */

import {
  splitTextIntoCompressionChunks,
  buildCompressionPromptForChunk,
  buildExistingStateFromSummaries,
} from './context-compression.js';
import { runAgentPrintSummary } from './fork-title.js';

/**
 * @param {{
 *   sourceText: string,
 *   existingSummaries?: Array<{ summary?: string }>,
 *   agentCmd: string,
 *   agentDir: string,
 *   model: string,
 * }} input
 * @returns {{ summary: string, title: string } | null}
 */
export function runMapReduceContextCompression(input) {
  const sourceText = String(input.sourceText || '').trim();
  if (!sourceText) return null;
  const chunks = splitTextIntoCompressionChunks(sourceText);
  if (chunks.length === 0) return null;
  let state = buildExistingStateFromSummaries(input.existingSummaries || []);
  let title = '';
  for (let index = 0; index < chunks.length; index += 1) {
    const prompt = buildCompressionPromptForChunk(
      chunks[index],
      state,
      index + 1,
      chunks.length,
    );
    const result = runAgentPrintSummary(input.agentCmd, input.agentDir, input.model, prompt);
    if (!result?.summary) return null;
    state = result.summary.trim();
    if (result.title) title = result.title.trim();
  }
  if (!state) return null;
  return { summary: state, title };
}
