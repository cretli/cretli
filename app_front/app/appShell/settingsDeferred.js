/**
 * Settings tabs that are only needed once the Settings panel is opened (usage, wakeups,
 * delegations, prompts, lessons, backups, MCP operator, approval broker). They live in
 * their own chunk so the chat boot does not download or evaluate them.
 */
import { initUsageSettings, refreshUsageSettings } from '../../features/usage/usageSettings.js';
import { initWakeupsSettings, refreshWakeupsSettings } from '../../features/wakeups/wakeupsSettings.js';
import { initApprovalBrokerSettings, refreshApprovalBrokerSettings } from '../../features/approval/approvalBrokerSettings.js';
import { initDelegationCenter, refreshDelegationCenter } from '../../features/delegations/delegationCenter.js';
import { initDelegationSettings, refreshDelegationSettings } from '../../features/settings/delegationSettings.js';
import { initAgentPromptsSettings, refreshAgentPromptsSettings } from '../../features/settings/agentPromptsSettings.js';
import { initMcpOperatorSettings, showMcpOperatorSettingsTab } from '../../features/settings/mcpOperatorSettings.js';
import { initReviewLessonsSettings, refreshReviewLessonsSettings } from '../../features/settings/reviewLessonsSettings.js';
import { initDataBackupSettings, refreshDataBackupSettings } from '../../features/settings/dataBackupSettings.js';
import { openTodo } from '../../features/todo/index.js';
import { isDelegationSettingsTab, isMcpOperatorSettingsTab } from '../../../lib/spa-routes.js';

let initialized = false;

/** Wires the deferred settings panels once; every init is idempotent on its own as well. */
export function initDeferredSettings() {
  if (initialized) return;
  initialized = true;
  initUsageSettings();
  initWakeupsSettings();
  initDelegationCenter();
  initDelegationSettings();
  initAgentPromptsSettings();
  initMcpOperatorSettings();
  initReviewLessonsSettings({ openTodo });
  initDataBackupSettings();
  initApprovalBrokerSettings();
}

/** @param {string} tabId */
export function refreshDeferredSettingsTab(tabId) {
  initDeferredSettings();
  if (tabId === 'harness-opencode-approvals') void refreshApprovalBrokerSettings();
  if (tabId === 'usage') void refreshUsageSettings();
  if (tabId === 'wakeups') void refreshWakeupsSettings();
  if (tabId === 'backups') void refreshDataBackupSettings();
  if (tabId === 'delegations') void refreshDelegationCenter();
  if (tabId === 'delegations-lessons') void refreshReviewLessonsSettings();
  else if (tabId === 'delegations-prompts') void refreshAgentPromptsSettings();
  else if (isDelegationSettingsTab(tabId) && tabId !== 'delegations') void refreshDelegationSettings();
  if (isMcpOperatorSettingsTab(tabId)) void showMcpOperatorSettingsTab(tabId);
}
