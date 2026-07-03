import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  createAnalyticsRecorder,
  withMcpAnalytics,
  type AnalyticsIngestBatch,
} from "../src/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { __clearClientInfoCache } from "../src/client-info-cache.js";
import { parseStatelessSessionClientInfo } from "../src/stateless-http.js";
import { __resetProcessScopedSessionIdForTests } from "../src/stdio-session.js";

// Regression suite for the "two `claude -p` conversations merged into one
// Armature activity" bug. stdio transports never carry a session id
// (`StdioServerTransport.sessionId` stays undefined; there are no HTTP
// headers), so every event went out with `session_id_hint: null` and no
// `session_init` was ever emitted. Ingest groups null-hint events into a
// per-actor DAILY bucket, so two distinct same-day CLI sessions from the same
// user became indistinguishable. The fix: a stdio server process serves
// exactly one connection, so the recorder falls back to a process-scoped
// session id whenever a request carries no session signal and no headers.

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

const stdioLikeRecorder = (emit: (batch: AnalyticsIngestBatch) => void) =>
  createAnalyticsRecorder({
    armature: { delivery: "await", actorId: "same-cli-user", emit },
  });

// What `Protocol._onrequest` hands tool callbacks on stdio: `sessionId` is
// `transport.sessionId` (undefined) and `requestInfo` is absent entirely.
const stdioExtra = {};

test("stdio: two server processes from the same actor get distinct, stable session ids (repro: merged claude -p activities)", async () => {
  // First `claude -p` run.
  __resetProcessScopedSessionIdForTests();
  const first = collectBatches();
  const firstRecorder = stdioLikeRecorder(first.emit);
  await firstRecorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    extra: stdioExtra,
    status: "ok",
    result: { content: [] },
  });
  await firstRecorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    extra: stdioExtra,
    status: "ok",
    result: { content: [] },
  });

  // Second `claude -p` run: a fresh process, simulated by resetting the
  // process-scoped id.
  __resetProcessScopedSessionIdForTests();
  const second = collectBatches();
  const secondRecorder = stdioLikeRecorder(second.emit);
  await secondRecorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    extra: stdioExtra,
    status: "ok",
    result: { content: [] },
  });

  const firstEvents = first.batches.flatMap((b) => b.events);
  const secondEvents = second.batches.flatMap((b) => b.events);

  // Before the fix every one of these hints was null — the exact payload
  // Codex observed ("the analytics event had session_id_hint: null") — and
  // ingest merged both runs into one fallback bucket.
  for (const event of [...firstEvents, ...secondEvents]) {
    assert.notEqual(event.session_id_hint, null, `${event.kind} must carry a session id on stdio`);
  }

  // Stable within one process: both tool calls and the session_init agree.
  const firstHints = new Set(firstEvents.map((e) => e.session_id_hint));
  assert.equal(firstHints.size, 1);

  // ...and a session_init is now emitted exactly once per stdio session.
  assert.equal(firstEvents.filter((e) => e.kind === "session_init").length, 1);

  // Distinct across processes: the two runs can no longer collapse into the
  // same activity.
  assert.notEqual(
    firstEvents[0]?.session_id_hint,
    secondEvents[0]?.session_id_hint,
    "two stdio processes must not share a session id",
  );

  // The fallback id must never be mistaken for an identity-bearing stateless
  // session id (which would fabricate a client name in the dashboard).
  assert.equal(
    parseStatelessSessionClientInfo(firstEvents[0]?.session_id_hint ?? undefined),
    undefined,
  );
});

test("HTTP-shaped requests (headers present, no session id) keep a null hint and emit no session_init", async () => {
  __resetProcessScopedSessionIdForTests();
  const { batches, emit } = collectBatches();
  const recorder = stdioLikeRecorder(emit);

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    // A stateless HTTP invocation that did not echo Mcp-Session-Id: headers
    // exist, so the process-scoped fallback must NOT kick in — many sessions
    // share one long-lived HTTP server process.
    extra: { requestInfo: { headers: { "user-agent": "node-fetch" } } },
    status: "ok",
    result: { content: [] },
  });

  const events = batches.flatMap((b) => b.events);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "tool_call");
  assert.equal(events[0]?.session_id_hint, null);
});

test("explicit null headers mean 'no HTTP request' — the stdio fallback still fires", async () => {
  __resetProcessScopedSessionIdForTests();
  const { batches, emit } = collectBatches();
  const recorder = stdioLikeRecorder(emit);

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    // Untyped JS callers can pass null where the types say undefined; both
    // mean the same thing here.
    extra: { requestInfo: { headers: null } } as never,
    status: "ok",
    result: { content: [] },
  });

  const events = batches.flatMap((b) => b.events);
  const toolCall = events.find((e) => e.kind === "tool_call");
  assert.equal(typeof toolCall?.session_id_hint, "string");
  assert.ok(String(toolCall?.session_id_hint).startsWith("stdio-"));
});

test("EMPTY headers still count as an HTTP request — no fallback, hint stays null", async () => {
  __resetProcessScopedSessionIdForTests();
  const { batches, emit } = collectBatches();
  const recorder = stdioLikeRecorder(emit);

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    // A pathological HTTP request whose headers were all stripped upstream:
    // present-but-empty must NOT be conflated with "no HTTP request".
    extra: { requestInfo: { headers: {} } },
    status: "ok",
    result: { content: [] },
  });

  const events = batches.flatMap((b) => b.events);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.session_id_hint, null);
});

test("headers passed directly on the event resolve mcp-session-id before any fallback", async () => {
  __resetProcessScopedSessionIdForTests();
  const { batches, emit } = collectBatches();
  const recorder = stdioLikeRecorder(emit);

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    headers: { "mcp-session-id": "header-session-77" },
    status: "ok",
    result: { content: [] },
  });

  const events = batches.flatMap((b) => b.events);
  const toolCall = events.find((e) => e.kind === "tool_call");
  assert.equal(toolCall?.session_id_hint, "header-session-77");
});

test("end-to-end over a session-less transport: session_init carries the handshake clientInfo", async () => {
  __resetProcessScopedSessionIdForTests();
  __clearClientInfoCache();

  const { batches, emit } = collectBatches();
  const { result: server } = withMcpAnalytics(
    { armature: { delivery: "await", actorId: "cli-user", emit } },
    () => {
      const s = new McpServer({ name: "stdio-server", version: "0.0.1" });
      s.registerTool(
        "echo",
        { description: "echo", inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: "text" as const, text: msg }] }),
      );
      return s;
    },
  );

  // InMemoryTransport has no sessionId — the same shape stdio presents to the
  // protocol layer.
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await client.callTool({ name: "echo", arguments: { msg: "hi" } });

    const events = batches.flatMap((b) => b.events);
    const sessionInit = events.find((e) => e.kind === "session_init");
    const toolCall = events.find((e) => e.kind === "tool_call");

    assert.ok(sessionInit, "stdio-shaped sessions must emit session_init");
    assert.ok(typeof sessionInit?.session_id_hint === "string");
    assert.equal(sessionInit?.session_id_hint, toolCall?.session_id_hint);
    // The initialize handshake was cached under the same process-scoped id,
    // so the Client column resolves for CLI sessions.
    assert.equal(sessionInit?.metadata.client_name, "claude-code");
    assert.equal(sessionInit?.metadata.client_version, "2.1.0");
  } finally {
    await client.close();
    await server.close();
  }
});
