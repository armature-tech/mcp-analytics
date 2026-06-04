import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpClientInfo } from "./types.js";

// In-process map keyed by transport sessionId. Populated by the patched
// `Server.prototype._oninitialize` and read by the recorder at tool-call time.
// Same instance the customer constructs, because `@modelcontextprotocol/sdk`
// is a peer dependency.
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

type ServerInternals = {
  _oninitialize?: (request: unknown) => Promise<unknown>;
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

// `Server.prototype._oninitialize` is a private method that runs on every
// `initialize` request, right before the handshake response is sent. Wrapping
// it lets us snapshot `clientInfo` and key it by `transport.sessionId` so the
// tool-call path can recover the client name even when the framework around
// the SDK (e.g. Mastra's `MCPServer`) never surfaces the underlying `Server`
// instance to the tool handler.
//
// Defensive: if the SDK ever renames the method, the patch is a no-op and the
// dashboard regresses to today's behaviour rather than breaking the server.
export const installClientInfoCapture = (): void => {
  if (initializePatchInstalled) return;
  const proto = Server.prototype as unknown as ServerInternals;
  if (typeof proto._oninitialize !== "function") return;
  initializePatchInstalled = true;

  const original = proto._oninitialize;
  proto._oninitialize = async function patchedOnInitialize(
    this: ServerInternals,
    request: unknown,
  ) {
    const result = await original.call(this, request);
    try {
      const params = extractInitializeParams(request);
      const sessionId =
        this.transport?.sessionId ?? params._meta?.sessionId ?? undefined;
      const info = params.clientInfo;
      const name = typeof info?.name === "string" ? info.name.trim() : "";
      if (sessionId && name.length > 0) {
        setCachedClientInfo(sessionId, {
          name,
          version:
            typeof info?.version === "string" ? info.version : undefined,
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : undefined,
          capabilities:
            typeof params.capabilities === "object" && params.capabilities !== null
              ? params.capabilities
              : null,
        });
      }
    } catch {
      // Capture is best-effort; never break the handshake.
    }
    return result;
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
