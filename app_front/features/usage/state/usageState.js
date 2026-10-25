/** Reactive state shared by the Usage views. */
import { signal } from '@lit-labs/signals';

export function createUsageState() {
  return {
    summary: signal(null),
    language: signal('en'),
    zoneDay: signal(new Date().toISOString().slice(0, 10)),
  };
}

export const usageState = createUsageState();
