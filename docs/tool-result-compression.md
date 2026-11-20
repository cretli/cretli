# Tool result compression experiment

The opt-in `CRETLI_TOOL_RESULT_COMPRESSION=1` prototype (a **server process** setting; the stdio bridge `scripts/cretli-mcp.js` never reads it) compresses the formatted `output` from `lib/mcp/mcp-runtime.js` before Cretli's tool loop sends it to the model. The flag is off by default. It strips ANSI escapes, collapses blank lines and horizontal whitespace, summarizes consecutive duplicate lines, minifies JSON where valid, and keeps the head and tail of long output. A SHA-256 reference points to the exact original in a process-local, 128-entry LRU. When enabled, the read-only builtin MCP tool `result_full` is listed for the model. Call it with `{ "id": "...", "offset": 0, "length": 4000 }` and follow `next_offset` until null to recover the exact original. The retrieval result itself is never compressed. Eviction or process restart loses recovery, so this prototype is unsuitable for durable results. The raw MCP result remains on the return object.

## Server decides, bridge follows

`callTool` returns `compression: { compressed }`. `/api/mcp/bridge/call` exposes it as a boolean `compressed` field, set **after** `...result.raw` so an external MCP server cannot spoof it. `mapBridgeToolResult` in `scripts/cretli-mcp.js` forwards `output` to the model only when `res.compressed === true`; it reads no env and does not inspect the `[full tool result: ` prefix. Server ON therefore compresses for every bridge regardless of its environment, and server OFF always yields the full text. `result_full` is listed (`listCretliMcpToolDefs`, `/api/mcp/bridge/tools`, `listBuiltinCretliCatalogToolNames`, the tool executor's builtin name check) only while the server flag is on.

Compression applies only when every MCP content item is text. Image, audio, resource, and mixed text/non-text results pass through unchanged; error results also pass through unchanged. This avoids changing the semantics of non-text payloads.

## Hook survey

`Yes` means the Cretli-owned path can replace a result before the model's next request. `Unknown` means this audit found no demonstrated replacement hook in the harness integration; stream events do not qualify. This is an integration survey, not a claim that the upstream SDK cannot support a hook.

| Harness | Replacement hook | Evidence |
| --- | --- | --- |
| OpenRouter | Yes, Cretli tool loop | `lib/agent-harness/llm-tool-loop.ts` constructs the tool message from `result.output`; MCP calls flow through `callContextTool` in `lib/mcp/mcp-service.js`. |
| OpenCode | Unknown for native tools; yes for Cretli MCP tools | `lib/opencode/opencode-agent-ws.js:611-612` consumes stream events; `callTool` in `lib/mcp/mcp-runtime.js` controls Cretli MCP results. |
| Claude | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/claude-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| Codex | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/codex-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| Cursor SDK | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/sdk-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| DeepSeek | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/deepseek-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| Qwen | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/qwen-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| CodeBuddy | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/codebuddy-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| Mistral | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/mistral-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| ZAI | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/zai-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |
| MiMo | Unknown for native tools; yes for Cretli MCP tools | `lib/mcp/adapters/mimo-adapter.js`; `callTool` in `lib/mcp/mcp-runtime.js`. |

The shared MCP path only covers tools called through Cretli's MCP runtime. Native tools run inside a harness remain outside this layer. The result formatter in `formatMcpToolResult`/`compressMcpResult` in `lib/mcp/mcp-runtime.js` and the `callTool` path are the interception point. The OpenRouter tool loop at `lib/agent-harness/llm-tool-loop.ts` shows why a Cretli-owned tool result can save model context tokens; changing only the UI event would not.

## Measurements

Run `node scripts/measure-tool-result-compression.mjs`. Values are **estimated tokens** (`ceil(characters / 4)`), including the recovery reference, not tokenizer counts. Fixtures are synthetic, stored under `tests/fixtures/tool-result-compression/`.

| Session fixture | Before | After |
| --- | ---: | ---: |
| Git diff | 1808 | 1541 |
| MCP JSON listing | 6763 | 1541 |
| Test runner output | 1776 | 104 |

This measures size only. It does not measure answer quality; the head/tail strategy can omit relevant lines. The compressor is deterministic, uses no network or new runtime dependency, and sends no data to a third party. Originals stay in this server process memory. Treat the reference id as sensitive because the model-callable `result_full` tool can read the original while its entry remains in memory.
