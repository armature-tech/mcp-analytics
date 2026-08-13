import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatelessSessionId,
  createAnalyticsRecorder,
  parseStatelessSessionClientInfo,
  resolveStatelessHttpSession,
} from "../src/index.js";
import type { AnalyticsIngestBatch } from "../src/index.js";

test("session id round-trips client identity", () => {
  const sessionId = buildStatelessSessionId({ name: "Claude Code", version: "2.0.13" });
  assert.match(sessionId, /^mcp_Claude-Code_v_2\.0\.13_[0-9a-f-]{36}$/);
  assert.deepEqual(parseStatelessSessionClientInfo(sessionId), {
    name: "Claude-Code",
    version: "2.0.13",
  });
});

test("anonymous and malformed session ids parse to undefined", () => {
  assert.match(buildStatelessSessionId(undefined), /^mcp_unknown_v__/);
  assert.equal(parseStatelessSessionClientInfo(buildStatelessSessionId(undefined)), undefined);
  assert.equal(parseStatelessSessionClientInfo("session_123"), undefined);
  assert.equal(parseStatelessSessionClientInfo(""), undefined);
  assert.equal(parseStatelessSessionClientInfo(undefined), undefined);
});

test("initialize requests mint an identity-bearing id and a generator for the transport", () => {
  const session = resolveStatelessHttpSession({
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "cursor", version: "1.5" } },
    },
    headers: {},
  });
  assert.equal(session.isInitialize, true);
  assert.ok(session.sessionId);
  assert.match(session.sessionId, /^mcp_cursor_v_1\.5_/);
  assert.equal(session.sessionIdGenerator?.(), session.sessionId);
  assert.deepEqual(session.dispatchContext, { sessionId: session.sessionId });
});

test("initialize inside a batch is detected", () => {
  const session = resolveStatelessHttpSession({
    body: [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "vscode" } } },
    ],
  });
  assert.equal(session.isInitialize, true);
  assert.ok(session.sessionId);
  assert.match(session.sessionId, /^mcp_vscode_v__/);
});

test("run-scoped session seed keeps proxy reconnects in one identity-bearing session", () => {
  const seed = "11111111-2222-4333-8444-555555555555";
  const initialize = () => resolveStatelessHttpSession({
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "mcp-tester-claude-remote-proxy", version: "0.1.0" } },
    },
    headers: { "X-Armature-Session-Seed": seed },
  });

  const first = initialize();
  const reconnected = initialize();
  assert.equal(first.sessionId, reconnected.sessionId);
  assert.equal(
    first.sessionId,
    `mcp_mcp-tester-claude-remote-proxy_v_0.1.0_${seed}`,
  );
  assert.deepEqual(parseStatelessSessionClientInfo(first.sessionId), {
    name: "mcp-tester-claude-remote-proxy",
    version: "0.1.0",
  });

  const call = resolveStatelessHttpSession({
    body: { jsonrpc: "2.0", id: 2, method: "tools/call" },
    headers: { "Mcp-Session-Id": first.sessionId, "X-Armature-Session-Seed": seed },
  });
  assert.equal(call.sessionId, first.sessionId);
});

test("run-scoped session seeds accept time-ordered UUID v7 values", () => {
  const seed = "019f942a-5d64-7322-8e50-5d17333768d9";
  assert.equal(
    buildStatelessSessionId({ name: "client" }, seed),
    `mcp_client_v__${seed}`,
  );
});

test("invalid session seeds never control the minted identifier", () => {
  const session = resolveStatelessHttpSession({
    body: { method: "initialize", params: { clientInfo: { name: "client" } } },
    headers: { "X-Armature-Session-Seed": "attacker-controlled" },
  });
  assert.ok(session.sessionId);
  assert.match(session.sessionId, /^mcp_client_v__[0-9a-f-]{36}$/);
  assert.doesNotMatch(session.sessionId, /attacker/);
});

test("tool-call requests recover identity from the echoed header (record and Headers)", () => {
  const issued = buildStatelessSessionId({ name: "claude-code", version: "2.0.13" });

  const fromRecord = resolveStatelessHttpSession({
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } },
    headers: { "Mcp-Session-Id": issued },
  });
  assert.equal(fromRecord.isInitialize, false);
  assert.equal(fromRecord.sessionId, issued);
  assert.equal(fromRecord.sessionIdGenerator, undefined);
  assert.deepEqual(fromRecord.clientInfo, { name: "claude-code", version: "2.0.13" });
  assert.deepEqual(fromRecord.dispatchContext, {
    sessionId: issued,
    clientInfo: { name: "claude-code", version: "2.0.13" },
  });

  const fromHeaders = resolveStatelessHttpSession({
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    headers: new Headers({ "mcp-session-id": issued }),
  });
  assert.equal(fromHeaders.sessionId, issued);
  assert.deepEqual(fromHeaders.clientInfo, { name: "claude-code", version: "2.0.13" });
});

// Regression: minting a one-off UUID here produced one trusted hint per POST,
// so ingest recorded a single-event session per tool call and its actor +
// client grouping never ran.
test("tool-call requests without an echoed header resolve to no session id", () => {
  const session = resolveStatelessHttpSession({
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } },
    headers: {},
  });
  assert.equal(session.isInitialize, false);
  assert.equal(session.sessionId, undefined);
  assert.equal(session.clientInfo, undefined);
  assert.equal(session.sessionIdGenerator, undefined);
  // Headers ride along so the recorder can tell "HTTP request with no session
  // id" from "no HTTP request at all". Without them it would fall back to the
  // process-scoped stdio id and merge every concurrent conversation in the
  // server into one session.
  assert.deepEqual(session.dispatchContext, { headers: {} });
});

test("two echo-less requests agree on no session id", () => {
  const body = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } };
  const first = resolveStatelessHttpSession({ body, headers: {} });
  const second = resolveStatelessHttpSession({ body, headers: {} });
  assert.equal(first.sessionId, undefined);
  assert.equal(second.sessionId, undefined);
});

// The custom-transport integration from the README: the caller spreads
// dispatchContext and nothing else. The event must carry no session hint, so
// ingest groups it — NOT the process-scoped `stdio-` id, which would merge
// every concurrent conversation in this process.
test("echo-less dispatch context ships a null hint, not the stdio process id", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "actor-seed",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const session = resolveStatelessHttpSession({
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } },
    headers: { "content-type": "application/json" },
  });
  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    durationMs: 5,
    status: "ok",
    result: { content: [{ type: "text", text: "ok" }] },
    ...session.dispatchContext,
  });

  const events = batches.flatMap((batch) => batch.events);
  const toolCalls = events.filter((event) => event.kind === "tool_call");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.session_id_hint, null);
});

test("recorder resolves client identity from identity-bearing session ids as a last resort", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "actor-seed",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const sessionId = buildStatelessSessionId({ name: "claude-code", version: "2.0.13" });
  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    sessionId,
    requestId: "request_1",
    durationMs: 5,
    status: "ok",
    result: { content: [{ type: "text", text: "ok" }] },
  });

  // Client identity surfaces on the session_init event (emitted lazily with
  // the first tool call of the session).
  const events = batches.flatMap((batch) => batch.events);
  const sessionInit = events.find((event) => event.kind === "session_init");
  assert.ok(events.some((event) => event.kind === "tool_call"));
  assert.equal(sessionInit?.metadata?.client_name, "claude-code");
  assert.equal(sessionInit?.metadata?.client_version, "2.0.13");
});
