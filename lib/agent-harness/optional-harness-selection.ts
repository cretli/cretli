/**
 * Which repo harness plugins are selected through `CRETLI_OPTIONAL_HARNESSES`.
 * A leaf module (no plugin or provider imports) shared by the boot loader and
 * the light lifecycle loader used by CLIs that never load the chat runtime.
 */

/** Env var holding the comma-separated ids of enabled repo plugins. */
export const OPTIONAL_HARNESSES_ENV = 'CRETLI_OPTIONAL_HARNESSES';

/**
 * @returns true when the variable is set, even to an empty string.
 */
export function isOptionalHarnessSelectionExplicit(env: Record<string, string | undefined> = process.env): boolean {
  return env?.[OPTIONAL_HARNESSES_ENV] !== undefined;
}

/**
 * @returns Trimmed, lowercased, de-duplicated ids (empty when unset).
 */
export function readEnabledOptionalHarnessIds(env: Record<string, string | undefined> = process.env): string[] {
  const raw = String(env?.[OPTIONAL_HARNESSES_ENV] || '');
  return [...new Set(raw.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Order ids so every dependency that is itself selected comes first. Stable for
 * ids without dependencies; a cycle falls back to the input order for the
 * members involved (the loader then reports the missing dependency).
 */
export function orderByDependencies(ids: readonly string[], dependsOnOf: (id: string) => readonly string[]): string[] {
  const selected = new Set(ids);
  const ordered: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const dep of dependsOnOf(id)) if (selected.has(dep)) visit(dep);
    visiting.delete(id);
    done.add(id);
    ordered.push(id);
  };
  for (const id of ids) visit(id);
  return ordered;
}
