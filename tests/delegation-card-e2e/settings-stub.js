/** Server-only settings must never be read by the browser card fixture. */
export function resolveDelegationEnv() {
  throw new Error('Browser cards must not read server delegation settings.');
}
