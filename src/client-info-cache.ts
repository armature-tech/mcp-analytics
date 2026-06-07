import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { HeaderBag, McpClientInfo } from "./types.js";
import { headerValue, isRecord } from "./utils.js";

// In-process map keyed by session id (transport sessionId and/or the
// `Mcp-Session-Id` request header). Populated by the patched
// `Server.prototype._onrequest` on `initialize` and read by the recorder at
// tool-call time. Same instance the customer constructs, because
// `@modelcontextprotocol/sdk` is a peer dependency.
//
// Bounded by `MAX_CACHE_ENTRIES` with FIFO eviction (Map iteration order is
// insertion order in JS, so the first key is the oldest). MCP `initialize`
// never fires a corresponding "session-closed" signal we can hook reliably —
// short-lived sessions on a long-running server would otherwise leak forever.
// 10k entries × ~200 bytes ≈ 2MB upper bound, well below anything operators
// would notice; the cap is far above any plausible concurrent-session count.
const MAX_CACHE_ENTRIES = 10_000;
const clientInfoBySessionId = new Map<string, McpClientInfo>();

const setCachedClientInfo = (sessionId: string, info: McpClientInfo) => {
  if (clientInfoBySessionId.has(sessionId)) {
    clientInfoBySessionId.delete(sessionId);
  } else if (clientInfoBySessionId.size >= MAX_CACHE_ENTRIES) {
    const oldest = clientInfoBySessionId.keys().next().value;
    if (oldest !== undefined) clientInfoBySessionId.delete(oldest);
  }
  clientInfoBySessionId.set(sessionId, info);
};

let initializePatchInstalled = false;

const HEADER_SESSION_ID = "mcp-session-id";

type ServerInternals = {
  _onrequest?: (request: unknown, extra?: unknown) => unknown;
  transport?: { sessionId?: string };
};

type InitializeRequestParams = {
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  _meta?: { sessionId?: string };
};

const extractInitializeParams = (request: unknown): InitializeRequestParams => {
  if (typeof request !== "object" || request === null) return {};
  const params = (request as { params?: unknown }).params;
  return typeof params === "object" && params !== null
    ? (params as InitializeRequestParams)
    : {};
};

const headersFromExtra = (extra: unknown): HeaderBag | undefined => {
  if (!isRecord(extra)) return undefined;
  const requestInfo = (extra as { requestInfo?: unknown }).requestInfo;
  if (!isRecord(requestInfo)) return undefined;
  return (requestInfo as { headers?: HeaderBag }).headers;
};

// Snapshot `clientInfo` from an `initialize` request and cache it under every
// session-id key we can observe. Stateless Streamable HTTP (Vercel et al.)
// disables `sessionIdGenerator`, so `transport.sessionId` is undefined and the
// client's identity instead arrives via the `Mcp-Session-Id` request header —
// the same value the tool-call path later normalizes to. Keying by transport
// id AND header id AND `_meta.sessionId` means the tool-call lookup hits
// regardless of which one that request resolves to.
const captureClientInfoFromInitialize = (
  server: ServerInternals,
  request: unknown,
  extra: unknown,
): void => {
  const params = extractInitializeParams(request);
  const info = params.clientInfo;
  const name = typeof info?.name === "string" ? info.name.trim() : "";
  if (name.length === 0) return;

  const headerSessionId =
    headerValue(headersFromExtra(extra), HEADER_SESSION_ID) ?? undefined;

  const sessionIds = new Set<string>();
  if (server.transport?.sessionId) sessionIds.add(server.transport.sessionId);
  if (headerSessionId) sessionIds.add(headerSessionId);
  if (params._meta?.sessionId) sessionIds.add(params._meta.sessionId);
  if (sessionIds.size === 0) return;

  const clientInfo: McpClientInfo = {
    name,
    version: typeof info?.version === "string" ? info.version : undefined,
    protocolVersion:
      typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : undefined,
    capabilities:
      typeof params.capabilities === "object" && params.capabilities !== null
        ? params.capabilities
        : null,
  };
  for (const sessionId of sessionIds) {
    setCachedClientInfo(sessionId, clientInfo);
  }
};

// `Server.prototype._onrequest` (inherited from `Protocol`) is the private
// dispatcher invoked for every inbound JSON-RPC request, and unlike the
// `initialize` handler — which the SDK registers as `request =>
// this._oninitialize(request)`, dropping the second argument — it receives both
// the request AND the per-request `extra` carrying `requestInfo.headers`. That
// makes it the only frame where the `initialize` payload's `clientInfo` and the
// `Mcp-Session-Id` header are in scope together, which we need for stateless
// HTTP. Wrapping it here also keeps the capture working when the framework
// around the SDK (e.g. Mastra's `MCPServer`) never surfaces the underlying
// `Server` instance to the tool handler.
//
// Defensive: if the SDK ever renames the method, the patch is a no-op and the
// dashboard regresses to today's behaviour rather than breaking the server.
export const installClientInfoCapture = (): void => {
  if (initializePatchInstalled) return;
  const proto = Server.prototype as unknown as ServerInternals;
  if (typeof proto._onrequest !== "function") return;
  initializePatchInstalled = true;

  const original = proto._onrequest;
  proto._onrequest = function patchedOnRequest(
    this: ServerInternals,
    request: unknown,
    extra?: unknown,
  ) {
    try {
      if (isRecord(request) && request.method === "initialize") {
        captureClientInfoFromInitialize(this, request, extra);
      }
    } catch {
      // Capture is best-effort; never break request handling.
    }
    return original.call(this, request, extra);
  };
};

export const getClientInfoForSessionId = (
  sessionId: string | undefined,
): McpClientInfo | undefined => {
  if (!sessionId) return undefined;
  return clientInfoBySessionId.get(sessionId);
};

// INTERNAL. Not part of the public API and may change or disappear in any
// release. These exports exist so the test suite can seed/clear shared module
// state without standing up a full MCP handshake. Downstream callers cannot
// reach them through the package name: `package.json#exports` only publishes
// `.` and `./mastra`, so Node refuses deep imports under either ESM `import`
// or CJS `require`.
export const __setClientInfoForSessionId = (
  sessionId: string,
  info: McpClientInfo,
): void => {
  setCachedClientInfo(sessionId, info);
};

export const __clearClientInfoCache = (): void => {
  clientInfoBySessionId.clear();
};

export const __isInitializePatchInstalled = (): boolean =>
  initializePatchInstalled;

export const __getClientInfoCacheSize = (): number =>
  clientInfoBySessionId.size;

export const __getMaxClientInfoCacheEntries = (): number => MAX_CACHE_ENTRIES;
