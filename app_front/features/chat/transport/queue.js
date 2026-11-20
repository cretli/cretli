/**
 * Mutable queue state shared by connection and background-monitor phases.
 * Queue draining remains owned by chatTransport because it needs the full
 * transport dependency graph.
 */
export function createTransportQueues() {
  return {
    pendingConnect: new Map(),
    backgroundReconnect: new Map(),
    pendingConnectDrainTimerId: null,
    backgroundReconnectTimerId: null,
  };
}

