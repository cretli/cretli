/**
 * Data compatibility for repo harness plugins that are known but not loaded.
 *
 * A plugin id stays a valid transport (chats, settings keys, favorites keep
 * referencing it) while the plugin itself is switched off through
 * CRETLI_OPTIONAL_HARNESSES. This module answers "is this id a known optional
 * plugin that is not loaded right now?" from the manifests alone: it never
 * imports plugin code, reads only `harnesses/<id>/harness-plugin.json` and
 * memoizes the result per root. Light side: safe to import from routes, the
 * WebSocket router and the chat message guard.
 */

import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveProjectPath } from '../runtime-paths.js';
import type { WebSocket } from 'ws';
import { getLoadedOptionalHarnessIds, isOptionalHarnessStateCommitted } from './optional-harness-state.ts';

/** Stable error/frame code for an action refused because the plugin is off. */
export const HARNESS_PLUGIN_DISABLED_CODE = 'harness_plugin_disabled';

export interface KnownOptionalHarness {
  id: string;
  label: string;
  dependsOn?: readonly string[];
}

const manifestCache = new Map<string, ReadonlyMap<string, KnownOptionalHarness>>();

/**
 * Known optional plugins found on disk: id -> label. Unreadable or foreign
 * manifests are skipped; the scan never throws.
 *
 * @param root Directory holding `<id>/harness-plugin.json`.
 */
export function listKnownOptionalHarnessManifests(root: string = resolveProjectPath('harnesses')): ReadonlyMap<string, KnownOptionalHarness> {
  const cached = manifestCache.get(root);
  if (cached) return cached;
  const found = new Map<string, KnownOptionalHarness>();
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(readFileSync(path.join(root, entry.name, 'harness-plugin.json'), 'utf8'));
        if (raw?.origin !== 'builtin-optional' || raw.id !== entry.name) continue;
        const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((dep: unknown): dep is string => typeof dep === 'string') : [];
        found.set(entry.name, {
          id: entry.name,
          label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : entry.name,
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
        });
      } catch {
        // A broken manifest is the loader's problem, not a reason to fail a read.
      }
    }
  } catch {
    // No harnesses directory.
  }
  manifestCache.set(root, found);
  return found;
}

/** Test-only: forget memoized manifest scans. */
export function resetKnownOptionalHarnessManifestsForTests(): void {
  manifestCache.clear();
}

/**
 * @returns The plugin when `harness` is a
 *   known optional plugin that the boot load did not register; null otherwise
 *   (including before the boot load committed).
 */
export function getDisabledOptionalHarness(
  harness: unknown,
  options: { root?: string; loadedIds?: readonly string[]; committed?: boolean } = {},
): KnownOptionalHarness | null {
  const id = typeof harness === 'string' ? harness.trim().toLowerCase() : '';
  if (!id) return null;
  const committed = options.committed !== undefined ? options.committed : isOptionalHarnessStateCommitted();
  if (!committed) return null;
  const known = listKnownOptionalHarnessManifests(options.root).get(id);
  if (!known) return null;
  const loaded = options.loadedIds || getLoadedOptionalHarnessIds();
  return loaded.includes(id) ? null : known;
}

export function describeDisabledOptionalHarness(plugin: KnownOptionalHarness, options: { loadedIds?: readonly string[] } = {}): string {
  const loaded = options.loadedIds || getLoadedOptionalHarnessIds();
  const missing = (plugin.dependsOn || []).filter((dep) => !loaded.includes(dep));
  if (missing.length > 0) {
    const labels = missing.map((dep) => listKnownOptionalHarnessManifests().get(dep)?.label || dep);
    return `The ${plugin.label} plugin is disabled: it needs the ${labels.join(', ')} plugin${labels.length > 1 ? 's' : ''}. Enable ${labels.length > 1 ? 'them' : 'it'} to continue this chat.`;
  }
  return `The ${plugin.label} plugin is disabled; enable it to continue this chat.`;
}

/**
 * Read-only socket for a chat whose plugin is off: no harness handler runs, so
 * nothing can write to the chat history. Prompt frames are answered with a
 * stable `sdkError` frame; every other frame is ignored.
 */
export function attachDisabledOptionalHarnessSocket(ws: WebSocket, plugin: KnownOptionalHarness): void {
  ws.on('message', (raw) => {
    let message: any;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message?.type !== 'send' && message?.type !== 'queueForceSend') return;
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({
      type: 'sdkError',
      code: HARNESS_PLUGIN_DISABLED_CODE,
      pluginId: plugin.id,
      message: describeDisabledOptionalHarness(plugin),
    }));
  });
}
