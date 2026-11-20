/** Browser-safe count shared by room snapshots and Claude session lifecycle. */
export function countClaudeBackgroundTasks(session: unknown): number {
  const tasks = (session as { backgroundTasks?: Set<string> } | null | undefined)?.backgroundTasks;
  return tasks instanceof Set ? tasks.size : 0;
}
