import { randomUUID } from "node:crypto";
import type { HeaderBag, McpClientInfo } from "./types.js";
import { headerValue, isRecord } from "./utils.js";

// Stateless HTTP deployments (Vercel, Lambda, Cloud Run with no sticky
// sessions) have no memory between invocations: the `initialize` request — the
// only one carrying `clientInfo` — lands on one instance, and tool calls land
// on others. Without help, every tool call records as a fresh anonymous
// session and the dashboard shows client "unknown".
//
// The fix needs no store at all: encode the client identity inside the session
// id minted at `initialize` (`mcp_<name>_v_<version>_<uuid>`). The MCP spec
// requires clients to echo the server-issued `Mcp-Session-Id` header on every
// subsequent request, so each invocation can parse client name/version back
// out of the header — warm or cold.
//
// Attribution is best-effort telemetry, not a security boundary: the echoed
// id carries no signature, so any caller can claim any client name. Gate
// access with real auth; treat client/session attribution as observability.
//
// `resolveStatelessHttpSession` is the one-call integration:
//
//   const session = resolveStatelessHttpSession({ body: req.body, headers: req.headers });
//   const transport = new StreamableHTTPServerTransport({
//     sessionIdGenerator: session.sessionIdGenerator, // defined only at initialize
//     enableJsonResponse: true,
//   });
//   await analytics.dispatch(name, args, { ctx, ...session.dispatchContext });

const SESSION_ID_RE =
  /^mcp_([A-Za-z0-9.-]+)_v_([A-Za-z0-9.-]*)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SESSION_SEED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ANONYMOUS_NAME = "unknown";

const slugPart = (value: unknown, fallback: string): string => {
  const slug = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
};

/** Mint a session id that carries the client identity from `initialize`. */
// Version falls back to an empty segment (`_v__`) so a client that never
// reported a version stays distinguishable from one reporting literal "0".
export const buildStatelessSessionId = (clientInfo?: McpClientInfo, sessionSeed?: string): string => {
  const seed = String(sessionSeed ?? "").trim();
  const uuid = SESSION_SEED_RE.test(seed) ? seed.toLowerCase() : randomUUID();
  return `mcp_${slugPart(clientInfo?.name, ANONYMOUS_NAME)}_v_${slugPart(clientInfo?.version, "")}_${uuid}`;
};

/** Recover the client identity from an identity-bearing session id. */
export const parseStatelessSessionClientInfo = (
  sessionId: string | undefined,
): McpClientInfo | undefined => {
  const match = SESSION_ID_RE.exec(String(sessionId ?? ""));
  if (!match || match[1] === ANONYMOUS_NAME) return undefined;
  return { name: match[1], ...(match[2] ? { version: match[2] } : {}) };
};

const findInitializeMessage = (body: unknown): Record<string, unknown> | undefined => {
  const messages = Array.isArray(body) ? body : [body];
  return messages.find(
    (message): message is Record<string, unknown> =>
      isRecord(message) && message.method === "initialize",
  );
};

const clientInfoFromInitialize = (message: Record<string, unknown> | undefined): McpClientInfo | undefined => {
  if (!message) return undefined;
  const params = isRecord(message.params) ? message.params : undefined;
  const info = params && isRecord(params.clientInfo) ? params.clientInfo : undefined;
  if (!info) return undefined;
  return {
    ...(typeof info.name === "string" ? { name: info.name } : {}),
    ...(typeof info.version === "string" ? { version: info.version } : {}),
  };
};

export type StatelessHttpSession = {
  /** Stable session id: minted at initialize, parsed from the echoed header otherwise. */
  sessionId: string;
  /** Client identity recovered from the echoed session id (tool-call requests only). */
  clientInfo?: McpClientInfo;
  /**
   * Defined only for initialize requests. Pass straight to
   * `StreamableHTTPServerTransport` so the response issues `Mcp-Session-Id`;
   * leaving it undefined on other requests keeps the transport stateless.
   */
  sessionIdGenerator?: () => string;
  /** True when the request (or any message in a batch) is `initialize`. */
  isInitialize: boolean;
  /** Spread into `dispatch(name, args, { ctx, ...dispatchContext })`. */
  dispatchContext: { sessionId: string; clientInfo?: McpClientInfo };
};

export const resolveStatelessHttpSession = (input: {
  /** Parsed JSON-RPC request body (single message or batch). */
  body?: unknown;
  /** Incoming request headers (Web `Headers` or a Node header record). */
  headers?: HeaderBag;
}): StatelessHttpSession => {
  const initialize = findInitializeMessage(input.body);
  if (initialize) {
    const clientInfo = clientInfoFromInitialize(initialize);
    const sessionId = buildStatelessSessionId(
      clientInfo,
      headerValue(input.headers, "x-armature-session-seed") ?? undefined,
    );
    return {
      sessionId,
      sessionIdGenerator: () => sessionId,
      isInitialize: true,
      dispatchContext: { sessionId },
    };
  }
  const echoed = headerValue(input.headers, "mcp-session-id");
  const sessionId = echoed?.trim() || randomUUID();
  const clientInfo = parseStatelessSessionClientInfo(sessionId);
  return {
    sessionId,
    isInitialize: false,
    ...(clientInfo ? { clientInfo } : {}),
    dispatchContext: { sessionId, ...(clientInfo ? { clientInfo } : {}) },
  };
};
