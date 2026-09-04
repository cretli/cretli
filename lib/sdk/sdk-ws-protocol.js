/** Server → client message types on `/ws-agent-sdk`. */
export const SDK_WS_SERVER_TYPES = Object.freeze({
  HELLO: 'hello',
  PONG: 'pong',
  SDK_EVENT: 'sdkEvent',
  SDK_RUN_FINISHED: 'sdkRunFinished',
  SDK_RUN_PROGRESS: 'sdkRunProgress',
  SDK_ROOM_STATE: 'sdkRoomState',
  SDK_QUEUED: 'sdkQueued',
  SDK_QUEUE_REMOVED: 'sdkQueueRemoved',
  SDK_MODE: 'sdkMode',
  SDK_ERROR: 'sdkError',
  SDK_AGENT: 'sdkAgent',
  SDK_PROMPT_STARTED: 'sdkPromptStarted',
  SDK_BUSY: 'sdkBusy',
  SDK_PLAN_GUARD: 'sdkPlanGuard',
  SDK_TTFT: 'sdkTtft',
  SDK_MODEL_FALLBACK: 'sdkModelFallback',
  REPLAY_BATCH_START: 'replayBatchStart',
  REPLAY_BATCH: 'replayBatch',
  REPLAY_BATCH_END: 'replayBatchEnd',
});

/** Client → server message types on `/ws-agent-sdk`. */
export const SDK_WS_CLIENT_TYPES = Object.freeze({
  SEND: 'send',
  CANCEL: 'cancel',
  SET_SDK_MODE: 'setSdkMode',
  PING: 'ping',
  WARMUP: 'warmup',
  RESIZE: 'resize',
});

/** Legacy PTY chat WebSocket message types (`/ws`, `/ws-agent`). */
export const PTY_WS_MESSAGE_TYPES = Object.freeze({
  OUTPUT: 'output',
  INPUT: 'input',
  RESIZE: 'resize',
  PING: 'ping',
  PONG: 'pong',
  SESSION_ID: 'sessionId',
  PTY_SIZE: 'ptySize',
  AGENT_LAUNCH: 'agentLaunch',
});

/** Types that bypass WS backpressure throttling (see `lib/sdk/sdk-ws-transport.js`). */
export const SDK_WS_CRITICAL_BROADCAST_TYPES = new Set([
  SDK_WS_SERVER_TYPES.SDK_EVENT,
  SDK_WS_SERVER_TYPES.SDK_RUN_FINISHED,
  SDK_WS_SERVER_TYPES.SDK_ERROR,
  SDK_WS_SERVER_TYPES.SDK_PROMPT_STARTED,
  SDK_WS_SERVER_TYPES.SDK_QUEUED,
  SDK_WS_SERVER_TYPES.SDK_QUEUE_REMOVED,
  SDK_WS_SERVER_TYPES.SDK_AGENT,
  SDK_WS_SERVER_TYPES.SDK_MODE,
  SDK_WS_SERVER_TYPES.SDK_PLAN_GUARD,
  SDK_WS_SERVER_TYPES.SDK_TTFT,
  SDK_WS_SERVER_TYPES.SDK_BUSY,
  SDK_WS_SERVER_TYPES.SDK_MODEL_FALLBACK,
  SDK_WS_SERVER_TYPES.REPLAY_BATCH,
  SDK_WS_SERVER_TYPES.REPLAY_BATCH_START,
  SDK_WS_SERVER_TYPES.REPLAY_BATCH_END,
]);

/** @deprecated Use SDK_WS_CRITICAL_BROADCAST_TYPES */
export const CRITICAL_BROADCAST_TYPES = SDK_WS_CRITICAL_BROADCAST_TYPES;
