/**
 * Optional loader for @anthropic-ai/claude-agent-sdk (optionalDependency).
 * Chat can run on other harnesses without this package installed.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Minimal structural view of the optional SDK module. The package lives under
 * `optional-packages/` (not resolvable by bare specifier, absent in CI), so its
 * own typings cannot be imported; callers narrow the `Query` handle locally.
 */
export interface ClaudeSdkQueryParams {
  prompt: string | AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}
export interface ClaudeSdkModule {
  query: (params: ClaudeSdkQueryParams) => any;
  [key: string]: unknown;
}

let sdkModulePromise: Promise<ClaudeSdkModule> | null = null;

/**
 * Test-only SDK override. Production never sets this; `loadClaudeSdk` returns
 * the fake so room/turn logic can run without spawning the CLI.
 */
let sdkModuleForTests: ClaudeSdkModule | null = null;

export function setClaudeSdkForTests(fake: ClaudeSdkModule | null): void {
  sdkModuleForTests = fake || null;
}

export function resetClaudeSdkForTests(): void {
  sdkModuleForTests = null;
}

const CLAUDE_SDK_ENTRY = pathToFileURL(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../optional-packages/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
)).href;

export function isClaudeSdkUnavailableError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  return code === 'CLAUDE_SDK_UNAVAILABLE' || code === 'ERR_MODULE_NOT_FOUND';
}

export function createClaudeSdkUnavailableError(cause?: unknown): Error & { code: string } {
  const error = new Error(
    'Claude Agent SDK is not installed. From the repo root run node scripts/install-optional-claude-sdk.js, '
    + 'or create a chat with the OpenCode, OpenRouter, or Cursor SDK harness.',
  );
  const coded = Object.assign(error, { code: 'CLAUDE_SDK_UNAVAILABLE' });
  if (cause) coded.cause = cause;
  return coded;
}

const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
let claudeExecutable: string | null | undefined;

/**
 * Native CLI binary of the SDK, resolved once per process with the SDK's own
 * candidate order. Without `pathToClaudeCodeExecutable` the SDK runs
 * `process.report.getReport()` on every `query()` to detect musl; in a server
 * with many open handles that report took seconds of event loop per session.
 */
export function resolveClaudeCodeExecutable(): string | null {
  if (claudeExecutable !== undefined) return claudeExecutable;
  claudeExecutable = null;
  const { platform, arch } = process;
  if (platform === 'android') return null;
  try {
    const requireFromSdk = createRequire(CLAUDE_SDK_ENTRY);
    let names = [`${CLAUDE_SDK_PACKAGE}-${platform}-${arch}`];
    if (platform === 'linux') {
      const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
      const musl = Boolean(report) && report?.header?.glibcVersionRuntime === undefined;
      const glibc = `${CLAUDE_SDK_PACKAGE}-linux-${arch}`;
      names = musl ? [`${glibc}-musl`, glibc] : [glibc, `${glibc}-musl`];
    }
    const binary = platform === 'win32' ? 'claude.exe' : 'claude';
    for (const name of names) {
      try {
        const candidate = requireFromSdk.resolve(`${name}/${binary}`);
        if (fs.existsSync(candidate)) {
          claudeExecutable = candidate;
          break;
        }
      } catch {
        // not installed for this platform variant
      }
    }
  } catch {
    claudeExecutable = null;
  }
  return claudeExecutable;
}

/** Wraps `query` so every call carries the resolved binary unless the caller set one. */
function withResolvedExecutable(sdk: ClaudeSdkModule): ClaudeSdkModule {
  return {
    ...sdk,
    query: (params: ClaudeSdkQueryParams) => {
      const executable = params?.options?.pathToClaudeCodeExecutable ? '' : resolveClaudeCodeExecutable();
      return sdk.query(executable ? { ...params, options: { ...params.options, pathToClaudeCodeExecutable: executable } } : params);
    },
  };
}

export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (sdkModuleForTests) return sdkModuleForTests;
  if (!sdkModulePromise) {
    sdkModulePromise = import(CLAUDE_SDK_ENTRY).then((sdk: ClaudeSdkModule) => withResolvedExecutable(sdk)).catch((err) => {
      sdkModulePromise = null;
      throw createClaudeSdkUnavailableError(err);
    });
  }
  return sdkModulePromise;
}

export async function isClaudeSdkAvailable(): Promise<boolean> {
  try {
    await loadClaudeSdk();
    return true;
  } catch (err) {
    if (isClaudeSdkUnavailableError(err)) return false;
    return false;
  }
}
