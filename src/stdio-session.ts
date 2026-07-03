import { randomUUID } from "node:crypto";

// Session identity for transports that have none: stdio (and in-process)
// servers never see an `Mcp-Session-Id` — `StdioServerTransport.sessionId`
// stays undefined and there is no HTTP request — so every event used to ship
// `session_id_hint: null`. Armature's ingest groups null-hint events into a
// coarse per-actor daily bucket, which merged *distinct* CLI conversations
// (e.g. two `claude -p` runs on the same day) into a single activity.
//
// A stdio MCP server process is spawned by its client and serves exactly one
// connection for its whole lifetime, so process identity IS session identity:
// mint one id per process, lazily, and reuse it for every event that has no
// other session signal. The recorder only falls back to this id for requests
// that carry no HTTP headers at all — on an HTTP server many sessions share
// one long-lived process, and pinning them all to a single id would be worse
// than the server-side fallback bucketing.
//
// The `stdio-` prefix deliberately does NOT match the stateless-HTTP
// `mcp_<name>_v_<version>_<uuid>` shape, so `parseStatelessSessionClientInfo`
// can never mistake it for an identity-bearing id and report a bogus client.
let processSessionId: string | undefined;

export const processScopedSessionId = (): string => {
  processSessionId ??= `stdio-${randomUUID()}`;
  return processSessionId;
};

// INTERNAL. Test-only reset so one test process can simulate several stdio
// server processes. Not reachable through the package name: `exports` only
// publishes `.` and `./mastra`.
export const __resetProcessScopedSessionIdForTests = (): void => {
  processSessionId = undefined;
};
