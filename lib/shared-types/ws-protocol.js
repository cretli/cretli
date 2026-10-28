/**
 * WebSocket messages exchanged by lib/ws/* and lib/sdk/* with app_front
 * (typedef-only module, no runtime code). Covers the terminal, agent-run,
 * task-run, server-log and front-build channels (lib/ws/*) and the SDK chat
 * socket (/ws-agent-sdk, lib/sdk/cursor-agent-sdk-ws.ts).
 * tests/strict-contract-typedefs.test.js fails when a handler sends or parses a
 * message `type` that is not declared here. Plan: docs/ts-migration-and-core-harnesses-plan.md,
 * A1 point 4.
 */

/**
 * Server → client: terminal or task-run output (also used for error text).
 * `catchUp` marks the replay of the buffered output on (re)connect.
 *
 * @typedef {{ type: 'output', data: string, catchUp?: boolean }} WsOutputMessage
 */

/** @typedef {{ type: 'pong' }} WsPongMessage */

/** @typedef {{ type: 'ptySize', cols: number, rows: number }} WsPtySizeMessage */

/** @typedef {{ type: 'sessionId', sessionId: string }} WsSessionIdMessage */


/** @typedef {{ type: 'taskRunId', runId: string }} WsTaskRunIdMessage */

/** @typedef {{ type: 'agentLaunch', commandLine: string, cwd: string }} WsAgentLaunchMessage */

/**
 * Server → client: a front build asset changed (PWA update banner).
 *
 * @typedef {{
 *   type: 'buildAssetChanged',
 *   assetType: string,
 *   file: string,
 *   serverInstanceToken: string,
 *   at: number,
 * }} WsBuildAssetChangedMessage
 */

/**
 * Every server → client message of the terminal/task/build channels.
 *
 * @typedef {WsOutputMessage | WsPongMessage | WsPtySizeMessage | WsSessionIdMessage
 *   | WsTaskRunIdMessage | WsAgentLaunchMessage | WsBuildAssetChangedMessage} WsServerMessage
 */

/** @typedef {{ type: 'ping' }} WsPingMessage */

/** @typedef {{ type: 'input', data: string }} WsInputMessage */

/** @typedef {{ type: 'resize', cols: number, rows: number }} WsResizeMessage */

/**
 * Page-bridge handshake: first message from an embedded widget page.
 *
 * @typedef {{ type: 'auth', token: string, pageSessionId: string }} WsPageBridgeAuthMessage
 */

/**
 * Client → server messages of the terminal channel.
 *
 * @typedef {WsPingMessage | WsInputMessage | WsResizeMessage | WsPageBridgeAuthMessage} WsClientMessage
 */

/**
 * SDK chat socket (/ws-agent-sdk) — server → client. Frames that carry replayed
 * history are tagged by the replay batch frames below.
 */

/**
 * First frame after connect: room snapshot (model, mode, last run outcome).
 *
 * @typedef {{
 *   type: 'hello',
 *   transport: 'cursor-sdk',
 *   sessionKey: string,
 *   agentId: string | null,
 *   modelId: string,
 *   sdkMode: string,
 *   eventStreamId: string,
 *   replayTagged: boolean,
 *   busy: boolean,
 *   hasCurrentRun: boolean,
 *   remoteStub: boolean,
 *   ownerInstanceId: string | null,
 *   queuedPrompts: string[],
 *   lastRunId: string | null,
 *   lastRunStatus: string | null,
 *   lastRunStatusNormalized: string | null,
 *   lastErrorCode: string | null,
 *   lastErrorMessage: string | null,
 *   requestedModelId: string | null,
 *   effectiveModelId: string | null,
 *   strictModelRequested: boolean,
 *   strictModelActive: boolean,
 *   lastModelFallback: Record<string, unknown> | null,
 * }} WsSdkHelloMessage
 */

/**
 * Periodic room state (busy flag, queue size, pending questions, steer support).
 *
 * @typedef {{
 *   type: 'sdkRoomState',
 *   eventStreamId: string,
 *   busy: boolean,
 *   hasCurrentRun: boolean,
 *   runId: string | null,
 *   lastRunId: string | null,
 *   lastRunStatus: string | null,
 *   lastErrorCode: string | null,
 *   lastErrorMessage: string | null,
 *   lastRoomEventSeq: number,
 *   queuedCount: number,
 *   clientCount: number,
 *   pendingQuestionCount: number,
 *   pendingPermissionCount: number,
 *   lastEventAt: number | null,
 *   transport: string | null,
 *   steerSupported: boolean,
 *   backgroundOutstanding: unknown,
 *   at: number,
 * }} WsSdkRoomStateMessage
 */

/** @typedef {{ type: 'sdkEvent', event: unknown }} WsSdkEventMessage */

/**
 * A run ended (finished, cancelled or failed).
 *
 * @typedef {{
 *   type: 'sdkRunFinished',
 *   runId: string,
 *   status: string,
 *   result: string,
 *   remaining?: number,
 *   lastErrorCode?: string,
 *   lastErrorMessage?: string,
 * }} WsSdkRunFinishedMessage
 */

/**
 * Setup or streaming progress while no SDK event has arrived yet.
 *
 * @typedef {{
 *   type: 'sdkRunProgress',
 *   phase: string,
 *   idleForMs: number,
 *   remainingMs: number | null,
 *   timeoutMs: number | null,
 *   overBudget?: boolean,
 * }} WsSdkRunProgressMessage
 */

/** @typedef {{ type: 'sdkQueued', position: number, text: string }} WsSdkQueuedMessage */

/** @typedef {{ type: 'sdkQueueRemoved', text: string }} WsSdkQueueRemovedMessage */

/** @typedef {{ type: 'sdkMode', mode: string }} WsSdkModeMessage */

/**
 * Error with a machine-readable `code` (e.g. missing_api_key, run_failed).
 *
 * @typedef {{ type: 'sdkError', code: string, message: string, ownerInstanceId?: string | null }} WsSdkErrorMessage
 */

/** @typedef {{ type: 'sdkAgent', agentId: string, modelId: string, sdkMode: string }} WsSdkAgentMessage */

/** @typedef {{ type: 'sdkPromptStarted', text: string, fromQueue: boolean, remaining: number }} WsSdkPromptStartedMessage */

/** @typedef {{ type: 'sdkBusy', message: string }} WsSdkBusyMessage */

/** @typedef {{ type: 'sdkPlanGuard', toolName: string, message: string }} WsSdkPlanGuardMessage */

/**
 * Time-to-first-token marks (epoch ms) and derived durations for one prompt.
 *
 * @typedef {{
 *   type: 'sdkTtft',
 *   clientSentAt: number | null,
 *   requestReceivedAt: number,
 *   agentReadyAt: number | null,
 *   sendResolvedAt: number | null,
 *   firstEventAt: number | null,
 *   firstAssistantAt: number | null,
 *   socketToServerMs: number | null,
 *   agentSetupMs: number,
 *   sendCallMs: number,
 *   sendToFirstEventMs: number,
 *   serverTtftMs: number,
 * }} WsSdkTtftMessage
 */

/** @typedef {{ type: 'sdkModelFallback', previousModelId: string, modelId: string }} WsSdkModelFallbackMessage */

/** @typedef {{ type: 'sdkSteerAck', runId: string, outcome: string, text: string, at: number }} WsSdkSteerAckMessage */

/** @typedef {{ type: 'sdkSteerError', code: string, message: string, runId: string, text: string, at: number }} WsSdkSteerErrorMessage */

/** @typedef {{ type: 'replayBatchStart', totalBatches: number, totalEvents: number }} WsSdkReplayBatchStartMessage */

/** @typedef {{ type: 'replayBatch', batchIndex: number, totalBatches: number, events: unknown[] }} WsSdkReplayBatchMessage */

/** @typedef {{ type: 'replayBatchEnd', totalBatches: number, totalEvents: number }} WsSdkReplayBatchEndMessage */

/**
 * Every server → client message of the SDK chat socket. `pong` is shared with
 * the terminal channel (WsPongMessage).
 *
 * @typedef {WsSdkHelloMessage | WsPongMessage | WsSdkRoomStateMessage | WsSdkEventMessage
 *   | WsSdkRunFinishedMessage | WsSdkRunProgressMessage | WsSdkQueuedMessage | WsSdkQueueRemovedMessage
 *   | WsSdkModeMessage | WsSdkErrorMessage | WsSdkAgentMessage | WsSdkPromptStartedMessage
 *   | WsSdkBusyMessage | WsSdkPlanGuardMessage | WsSdkTtftMessage | WsSdkModelFallbackMessage
 *   | WsSdkSteerAckMessage | WsSdkSteerErrorMessage | WsSdkReplayBatchStartMessage
 *   | WsSdkReplayBatchMessage | WsSdkReplayBatchEndMessage} WsSdkServerMessage
 */

/**
 * SDK chat socket — client → server. `ping` is shared with the terminal channel.
 */

/** @typedef {{ type: 'warmup' }} WsSdkWarmupMessage */

/** @typedef {{ type: 'cancel' }} WsSdkCancelMessage */

/** @typedef {{ type: 'setSdkMode', mode: string }} WsSdkSetModeMessage */

/**
 * Prompt submission body shared by `send` and `steer`.
 *
 * @typedef {{
 *   text: string,
 *   mode?: string,
 *   clientSentAt?: number,
 *   displayText?: string,
 *   selectedSkillIds?: string[],
 *   skillMentions?: boolean,
 * }} WsSdkPromptBody
 */

/** @typedef {{ type: 'send' } & WsSdkPromptBody} WsSdkSendMessage */

/** Injects text into the active run. */
/** @typedef {{ type: 'steer' } & WsSdkPromptBody} WsSdkSteerMessage */

/** @typedef {{ type: 'queueRemove', text: string }} WsSdkQueueRemoveMessage */

/** @typedef {{ type: 'queueForceSend', text: string }} WsSdkQueueForceSendMessage */

/**
 * @typedef {WsPingMessage | WsSdkWarmupMessage | WsSdkCancelMessage | WsSdkSetModeMessage
 *   | WsSdkSendMessage | WsSdkSteerMessage | WsSdkQueueRemoveMessage | WsSdkQueueForceSendMessage} WsSdkClientMessage
 */

export {};
