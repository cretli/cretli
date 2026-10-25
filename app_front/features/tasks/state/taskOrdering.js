/** Ordering of the Tasks dropdown: favourites first, available tasks grouped by folder. */

export function orderTasksForList(scopedRuns, tasksAvailable, taskFavorites) {
  const orderedTaskRuns = scopedRuns
    .map((run, idx) => ({ run, idx }))
    .sort((a, b) => {
      const af = taskFavorites.isFavorite(a.run.taskLabel) ? 1 : 0;
      const bf = taskFavorites.isFavorite(b.run.taskLabel) ? 1 : 0;
      if (af !== bf) return bf - af;
      return a.idx - b.idx;
    })
    .map((x) => x.run);
  const folderOrder = [];
  tasksAvailable.forEach((task) => {
    const folderKey = task.folderPath || task.folderName || '';
    if (!folderOrder.includes(folderKey)) folderOrder.push(folderKey);
  });
  const orderedTasksAvailable = tasksAvailable
    .map((task, idx) => ({ task, idx }))
    .sort((a, b) => {
      const fa = folderOrder.indexOf(a.task.folderPath || a.task.folderName || '');
      const fb = folderOrder.indexOf(b.task.folderPath || b.task.folderName || '');
      if (fa !== fb) return fa - fb;
      const favA = taskFavorites.isFavorite(a.task.label) ? 1 : 0;
      const favB = taskFavorites.isFavorite(b.task.label) ? 1 : 0;
      if (favA !== favB) return favB - favA;
      return a.idx - b.idx;
    })
    .map((x) => x.task);
  return { orderedTaskRuns, orderedTasksAvailable };
}
