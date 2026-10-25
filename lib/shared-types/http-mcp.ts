/**
 * Structural Express request/response types and the MCP tool context. No
 * `@types/express` dependency: only the members lib/ actually reads. Types only.
 */

export type ExpressRequest = {
  method: string;
  url: string;
  originalUrl: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body?: any;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  get(name: string): string | undefined;
  [key: string]: unknown;
};

export type ExpressResponse = {
  statusCode: number;
  status(code: number): ExpressResponse;
  json(body: unknown): ExpressResponse;
  send(body?: unknown): ExpressResponse;
  end(chunk?: unknown): void;
  set(name: string, value: string | string[]): ExpressResponse;
  setHeader(name: string, value: string | string[] | number): ExpressResponse;
  type(value: string): ExpressResponse;
  write(chunk: unknown): boolean;
  headersSent: boolean;
  [key: string]: unknown;
};

export type ExpressNext = (err?: unknown) => void;

export type ExpressHandler = (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => unknown;

/** Resolved caller context of a builtin MCP tool (`resolveCretliToolContext`). */
export type McpToolContext = {
  chatId: string;
  workspaceId: string;
  workspaceFolder: string;
  workspaceFile: string;
  harness: string;
  mode: string;
};

/** Raw MCP session handed to builtin tools (input of `resolveCretliToolContext`). */
export type McpToolSession = Partial<McpToolContext> & {
  sessionId?: string;
  revision?: number;
  [key: string]: unknown;
};
