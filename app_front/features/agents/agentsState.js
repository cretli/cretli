/**
 * Signal state for the Agents panel. Plain run objects (terminals, sockets) stay owned by the run
 * engine; this module mirrors only what the views render, so one run change touches one row.
 */
import { computed, signal } from '@lit-labs/signals';

export const AGENT_VALUE_PREFIX = 'agent:';
const SCHEDULE_DEFAULT_INTERVAL = 60;

/**
 * @typedef {{ name: string }} AgentInfo
 * @typedef {{ agentName: string, enabled?: boolean, intervalMinutes?: number }} AgentSchedule
 */

/**
 * @param {(name: string) => boolean} isFavorite
 * @param {(key: string) => string} translate
 */
export function createAgentsState(isFavorite, translate) {
  /** Bumped when favorites change, because the favorites store is not reactive. */
  const favoritesTick = signal(0);
  const agents = signal(/** @type {AgentInfo[]} */ ([]));
  /** @type {import('@lit-labs/signals').Signal.State<Array<ReturnType<typeof createRunView>>>} */
  const runViews = signal([]);
  const selectedValue = signal('');
  const scheduleAgents = signal(/** @type {AgentInfo[]} */ ([]));
  const schedules = signal(/** @type {AgentSchedule[]} */ ([]));

  const byFavoriteFirst = (nameOf) => (a, b) => {
    const af = isFavorite(nameOf(a)) ? 1 : 0;
    const bf = isFavorite(nameOf(b)) ? 1 : 0;
    return bf - af;
  };
  /** Array.prototype.sort is stable, so ties keep their original order. */
  const orderedRuns = computed(() => {
    favoritesTick.get();
    return runViews.get().slice().sort(byFavoriteFirst((v) => v.agentName));
  });
  const availableAgents = computed(() => {
    const running = new Set(runViews.get().map((v) => v.agentName));
    return agents.get().filter((a) => !running.has(a.name));
  });
  const orderedAvailable = computed(() => {
    favoritesTick.get();
    return availableAgents.get().slice().sort(byFavoriteFirst((a) => a.name));
  });

  /** Per-run view model; each field is its own signal so a title change only updates that row. */
  function createRunView(run) {
    const displayTitle = signal(run.displayTitle || null);
    const status = signal(run.status || 'running');
    const hasRunId = signal(!!run.runId);
    const label = computed(() => {
      const suffix =
        status.get() === 'finished' ? translate('agents.finished') : hasRunId.get() ? '' : translate('agents.connecting');
      return (displayTitle.get() || run.agentName) + suffix;
    });
    return { id: run.id, agentName: run.agentName, displayTitle, status, hasRunId, label };
  }

  /** Mirrors the engine's run objects into per-run signals, keeping existing views (and rows) alive. */
  function syncRuns(runs) {
    const prev = new Map(runViews.get().map((v) => [v.id, v]));
    const next = runs.map((run) => {
      const view = prev.get(run.id) || createRunView(run);
      view.displayTitle.set(run.displayTitle || null);
      view.status.set(run.status || 'running');
      view.hasRunId.set(!!run.runId);
      return view;
    });
    const current = runViews.get();
    if (next.length !== current.length || next.some((v, i) => v !== current[i])) runViews.set(next);
  }

  /** Per-agent form edits not yet saved; rows not rendered yet fall back to the stored schedule. */
  const scheduleDrafts = new Map();
  const scheduleByAgent = computed(() => new Map(schedules.get().map((s) => [s.agentName, s])));

  function setSchedule(agentList, scheduleList) {
    scheduleDrafts.clear();
    scheduleAgents.set(agentList);
    schedules.set(scheduleList);
  }

  function scheduleRowValue(name) {
    const draft = scheduleDrafts.get(name);
    if (draft) return draft;
    const s = /** @type {Partial<AgentSchedule>} */ (scheduleByAgent.get().get(name) || {});
    return { enabled: !!s.enabled, intervalMinutes: s.intervalMinutes || SCHEDULE_DEFAULT_INTERVAL };
  }

  function editSchedule(name, patch) {
    scheduleDrafts.set(name, { ...scheduleRowValue(name), ...patch });
  }

  function collectSchedules(agentList) {
    return (agentList || []).map((agent) => {
      const v = scheduleRowValue(agent.name);
      const minutes = parseInt(String(v.intervalMinutes), 10);
      return {
        agentName: agent.name,
        enabled: !!v.enabled,
        intervalMinutes: Number.isFinite(minutes) && minutes >= 1 ? minutes : SCHEDULE_DEFAULT_INTERVAL,
      };
    });
  }

  return {
    favoritesTick,
    agents,
    runViews,
    selectedValue,
    scheduleAgents,
    orderedRuns,
    orderedAvailable,
    availableAgents,
    syncRuns,
    setSchedule,
    scheduleRowValue,
    editSchedule,
    collectSchedules,
  };
}
