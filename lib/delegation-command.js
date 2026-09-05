/**
 * Slash command for delegating the approved plan.
 */

/**
 * @param {unknown} text
 * @returns {{ command: 'execute', extraInstructions: string } | null}
 */
export function parseDelegationCommand(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  if (/```/.test(raw)) return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/^\/(wykonaj|execute)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    command: 'execute',
    extraInstructions: String(match[2] || '').trim(),
  };
}
