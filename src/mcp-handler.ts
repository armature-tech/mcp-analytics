import type { McpAnalyticsConfig } from "./types.js";
import {
  createAnalyticsRecorderCore,
  type AnalyticsRecorderCore,
} from "./recorder-core.js";
import { defaultMcpAnalyticsConfig } from "./emit.js";
import {
  clientInfoFromInitializeBody,
  resolveStatelessHttpSession,
} from "./stateless-http.js";

// Session/client-identity shim for Vercel's `mcp-handler` (npm mcp-handler,
// peer-pinned to @modelcontextprotocol/sdk@1.26.0). mcp-handler hands the
// user's initialize callback a REAL official-SDK `McpServer`, so the package
// root's `withMcpAnalytics` prototype patch covers its tool calls transitively
// — verified empirically in tests/mcp-handler-compat.test.ts, including the
// module-format caveat (the SDK ships distinct ESM and CJS builds; coverage
// holds because mcp-handler and this package resolve the SAME build in any
// same-format host, and would break only in a host that mixes formats).
//
// What mcp-handler does NOT provide (verified against
// node_modules/mcp-handler/dist/index.js): its streamable-HTTP leg constructs
// `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator })` where
// `sessionIdGenerator` is TYPED `undefined` in its Config — stateless only.
// No `Mcp-Session-Id` is ever minted, so clients have nothing to echo:
// without this shim every tool call records with a null session hint and an
// unknown client (the `initialize` carrying clientInfo lands on a throwaway
// per-request `McpServer`).
//
// This wrapper is the v1 stateless-HTTP pattern (see stateless-http.ts)
// applied at the only place mcp-handler's request path lets us reach: the
// `(request: Request) => Promise<Response>` handler it returns. On a POST
// whose body contains `initialize`, it mints the identity-bearing session id
// (`mcp_<name>_v_<version>_<uuid>`, honoring `X-Armature-Session-Seed` as the
// uuid seed), records the `session_init` (with the initialize body's
// clientInfo/protocolVersion/capabilities), and attaches the id as the
// response's `Mcp-Session-Id`. Spec-conforming clients echo that header on
// every subsequent request, where the package root's recorder resolves it
// from `extra.requestInfo.headers` and recovers the client identity from the
// id itself (`parseStatelessSessionClientInfo`) — warm or cold, any instance.

export type McpRouteHandler = (
  request: Request,
  // Next.js route handlers receive (request, context); forward anything extra.
  ...rest: unknown[]
) => Promise<Response>;

const SESSION_ID_HEADER = "mcp-session-id";

type McpHandlerRecorderState = {
  core: AnalyticsRecorderCore;
};

// Keyed on the config object so every request shares one recorder (privacy
// queue + session_init dedupe) — hoist the config, same contract as the v2
// adapter. A fresh config per call still converges at ingest (session_init
// event ids are content-addressed per (actor, session)).
const recorderStatesByConfig = new WeakMap<McpAnalyticsConfig, McpHandlerRecorderState>();
let defaultRecorderState: McpHandlerRecorderState | undefined;

const recorderStateFor = (
  config: McpAnalyticsConfig | undefined,
): McpHandlerRecorderState => {
  if (config === undefined || config === defaultMcpAnalyticsConfig) {
    defaultRecorderState ??= { core: createAnalyticsRecorderCore(defaultMcpAnalyticsConfig) };
    return defaultRecorderState;
  }
  let state = recorderStatesByConfig.get(config);
  if (!state) {
    state = { core: createAnalyticsRecorderCore(config) };
    recorderStatesByConfig.set(config, state);
  }
  return state;
};

/** Drain the analytics pipeline tied to a config object (or the default config). */
export const flushMcpHandlerAnalytics = (
  config?: McpAnalyticsConfig,
): Promise<void> => {
  return recorderStateFor(config).core.flush();
};

const withSessionIdHeader = (response: Response, sessionId: string): Response => {
  if (response.headers.get(SESSION_ID_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.set(SESSION_ID_HEADER, sessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Wrap the handler returned by mcp-handler's `createMcpHandler` so MCP client
 * and session identity survive its stateless transport. Pass the SAME config
 * object here and to the `withMcpAnalytics` call inside your initialize
 * callback so both share one delivery pipeline configuration:
 *
 * ~~~ts
 * const handler = withMcpHandlerAnalytics(
 *   createMcpHandler((server) => {
 *     withMcpAnalytics(analyticsConfig, () => {
 *       server.tool(...); // instrumented by the package root's patch
 *       return server;
 *     });
 *   }),
 *   analyticsConfig,
 * );
 * export { handler as POST };
 * ~~~
 *
 * Serverless note: `createMcpHandler` runs the initialize callback PER
 * REQUEST, so use `delivery: "await"` (or a `schedule`/`waitUntil` hook) —
 * a per-request background queue may be frozen before it delivers.
 */
export const withMcpHandlerAnalytics = <H extends McpRouteHandler>(
  handler: H,
  config?: McpAnalyticsConfig,
): H => {
  const state = recorderStateFor(config);

  const wrapped = async (request: Request, ...rest: unknown[]): Promise<Response> => {
    let session: ReturnType<typeof resolveStatelessHttpSession> | undefined;
    let body: unknown;
    if (request.method === "POST") {
      try {
        const raw = await request.clone().text();
        body = raw ? JSON.parse(raw) : undefined;
        session = resolveStatelessHttpSession({ body, headers: request.headers });
      } catch {
        session = undefined;
      }
    }

    const response = await handler(request, ...rest);

    if (session?.isInitialize && response.ok) {
      try {
        await state.core.recordSessionInit({
          sessionId: session.sessionId,
          headers: request.headers,
          clientInfo: clientInfoFromInitializeBody(body),
          extra: {
            sessionId: session.sessionId,
            requestInfo: { headers: request.headers },
          },
        });
      } catch {
        // Recording is best-effort; never break the MCP response over it.
      }
      return withSessionIdHeader(response, session.sessionId);
    }

    // Echo an id the client is already carrying, so it keeps carrying it.
    const echoed = request.headers.get(SESSION_ID_HEADER)?.trim();
    if (echoed) return withSessionIdHeader(response, echoed);
    return response;
  };

  return wrapped as H;
};

export type { AnalyticsRecorderCore } from "./recorder-core.js";
export type { McpAnalyticsConfig, McpClientInfo } from "./types.js";
export { defaultMcpAnalyticsConfig } from "./emit.js";
