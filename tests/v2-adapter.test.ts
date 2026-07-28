import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  conversationIdFromBaggage,
  instrumentedFactory,
  SESSION_SEED_HEADER,
  withMcpAnalytics,
  wrapMcpHandler,
  type AnalyticsIngestBatch,
  type McpAnalyticsConfig,
} from "../src/v2.js";
import { __resetProcessScopedSessionIdForTests } from "../src/stdio-session.js";

// The v2 adapter under the conditions that matter for the 2026-07-28
// migration: a real `createMcpHandler` driven in BOTH eras by real
// @modelcontextprotocol/client 2.0.0 clients (modern via versionNegotiation,
// legacy via the default connect()), plus direct wrapped-callback invocations
// for the session-id ladder permutations that in-process HTTP cannot produce
// deterministically (a sessionful legacy transport, stdio).

const SEED_A = "11111111-2222-4333-8444-555555555555";
const SEED_B = "99999999-8888-4777-8666-555555555555";

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    events: () => batches.flatMap((b) => b.events),
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

const testConfig = (
  emit: (batch: AnalyticsIngestBatch) => void,
  overrides: NonNullable<McpAnalyticsConfig["armature"]> = {},
): McpAnalyticsConfig => ({
  armature: {
    delivery: "await",
    actorId: "v2-test-actor",
    emit,
    ...overrides,
  },
});

const ECHO_INPUT_SCHEMA = fromJsonSchema({
  type: "object",
  properties: { msg: { type: "string" } },
});

const buildEchoServer = (onArgs?: (args: unknown) => void) => {
  const server = new McpServer(
    { name: "v2-fixture", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "echo",
    { description: "Echo a message.", inputSchema: ECHO_INPUT_SCHEMA },
    async (args: unknown) => {
      onArgs?.(args);
      const msg = (args as { msg?: string } | undefined)?.msg;
      return { content: [{ type: "text" as const, text: `echo:${msg}` }] };
    },
  );
  return server;
};

// In-process serving (no sockets): the URL is never dialed — handler.fetch
// serves the request directly, per the SDK's own testing guidance.
const inProcessTransport = (
  handler: { fetch: (request: Request) => Promise<Response> },
  extraHeaders: Record<string, string> = {},
) =>
  new StreamableHTTPClientTransport(new URL("http://in-process.local/mcp"), {
    fetch: (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(extraHeaders)) {
        headers.set(name, value);
      }
      return handler.fetch(new Request(url, { ...init, headers }));
    },
  });

const modernClient = () =>
  new Client(
    { name: "v2-modern-client", version: "3.2.1" },
    { versionNegotiation: { mode: "auto" } },
  );

const legacyClient = () => new Client({ name: "v2-legacy-client", version: "1.0.0" });

// ─── Modern era end-to-end ──────────────────────────────────────────────────

test("v2 modern era: tool_call wire shape, per-request client identity, one session_init per session key", async () => {
  const { events, emit } = collectBatches();
  const handler = createMcpHandler(
    instrumentedFactory(() => buildEchoServer(), testConfig(emit)),
  );

  const client = modernClient();
  await client.connect(
    inProcessTransport(handler, { [SESSION_SEED_HEADER]: SEED_A }),
  );
  try {
    assert.equal(client.getProtocolEra(), "modern");

    const first = await client.callTool({
      name: "echo",
      arguments: { msg: "one" },
    });
    assert.equal((first.content as { text?: string }[])[0]?.text, "echo:one");
    await client.callTool({ name: "echo", arguments: { msg: "two" } });

    const toolCalls = events().filter((e) => e.kind === "tool_call");
    const sessionInits = events().filter((e) => e.kind === "session_init");
    assert.equal(toolCalls.length, 2);
    assert.equal(
      sessionInits.length,
      1,
      "session_init must be emitted exactly once per session key",
    );

    for (const event of toolCalls) {
      // Wire shape per packages/TELEMETRY-CONTRACT.md — identical to v1.
      assert.match(String(event.event_id), /^[0-9a-f]{64}$/);
      assert.match(String(event.actor_id), /^[0-9a-f]{64}$/);
      assert.equal(event.ok, true);
      assert.equal(event.error, null);
      assert.equal(event.session_id_hint, SEED_A, "seed header must key the session");
      assert.equal(event.metadata.tool_name, "echo");
      assert.equal(event.metadata.user_intent, null);
      assert.equal(event.metadata.intent, null);
      assert.equal(event.metadata.agent_thinking, null);
      assert.ok(typeof event.metadata.input_preview === "string");
      assert.match(String(event.script_source), /^MCP tool call: echo/);
      assert.deepEqual(event.calls, []);
      // Identity is per-request on 2026-07-28, so it rides tool_call too.
      assert.equal(event.metadata.client_name, "v2-modern-client");
      assert.equal(event.metadata.client_version, "3.2.1");
      assert.equal(event.metadata.protocol_version, "2026-07-28");
    }
    assert.equal(
      new Set(toolCalls.map((e) => e.event_id)).size,
      2,
      "each invocation mints its own event_id",
    );

    const init = sessionInits[0];
    assert.equal(init?.session_id_hint, SEED_A);
    assert.equal(init?.metadata.client_name, "v2-modern-client");
    assert.equal(init?.metadata.client_version, "3.2.1");
    assert.equal(init?.metadata.protocol_version, "2026-07-28");
    assert.ok(
      init !== undefined && typeof init.metadata.capabilities === "object",
      "envelope clientCapabilities must reach session_init metadata",
    );
  } finally {
    await client.close();
  }
});

test("v2 modern era: a telemetry argument is stripped from the handler and exported; baggage beats the seed header", async () => {
  const { events, emit } = collectBatches();
  let received: unknown;
  const handler = createMcpHandler(
    instrumentedFactory(() => buildEchoServer((args) => {
      received = args;
    }), testConfig(emit)),
  );

  const client = modernClient();
  await client.connect(
    inProcessTransport(handler, { [SESSION_SEED_HEADER]: SEED_A }),
  );
  try {
    await client.callTool({
      name: "echo",
      arguments: {
        msg: "with telemetry",
        telemetry: { user_intent: "v2 round trip", agent_thinking: "thinking" },
      },
      _meta: {
        baggage: "team=core,gen_ai.conversation.id=conv%2D42%20alpha",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      },
    });

    assert.ok(received !== null && typeof received === "object");
    assert.equal(
      "telemetry" in (received as Record<string, unknown>),
      false,
      "telemetry must be stripped before the customer handler",
    );

    const toolCall = events().find((e) => e.kind === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall?.metadata.user_intent, "v2 round trip");
    assert.equal(toolCall?.metadata.agent_thinking, "thinking");
    // Ladder rung 1 (baggage conversation id, URL-decoded) beats rung 2 (seed).
    assert.equal(toolCall?.session_id_hint, "conv-42 alpha");
    // Trace keys are NOT lifted into the envelope; they arrive in _meta and are
    // captured verbatim as request_meta.
    const requestMeta = toolCall?.metadata.request_meta as Record<string, unknown>;
    assert.equal(
      requestMeta.traceparent,
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
    assert.match(String(requestMeta.baggage), /gen_ai\.conversation\.id/);
    assert.equal(toolCall?.metadata.request_meta_truncated, undefined);
  } finally {
    await client.close();
  }
});

test("v2 modern era: an isError tool result is recorded as a failed call", async () => {
  const { events, emit } = collectBatches();
  const handler = createMcpHandler(
    instrumentedFactory(() => {
      const server = new McpServer(
        { name: "v2-fixture", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );
      server.registerTool(
        "fail",
        { inputSchema: ECHO_INPUT_SCHEMA },
        async () => ({
          isError: true as const,
          content: [{ type: "text" as const, text: "upstream exploded (503)" }],
        }),
      );
      return server;
    }, testConfig(emit)),
  );

  const client = modernClient();
  await client.connect(inProcessTransport(handler));
  try {
    const result = await client.callTool({ name: "fail", arguments: { msg: "x" } });
    assert.equal(result.isError, true);
    const toolCall = events().find((e) => e.kind === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall?.ok, false);
    assert.match(String(toolCall?.error), /upstream exploded \(503\)/);
  } finally {
    await client.close();
  }
});

// ─── Legacy era end-to-end ──────────────────────────────────────────────────

test("v2 legacy era through wrapMcpHandler: identity-bearing Mcp-Session-Id is minted, echoed, and attributed", async () => {
  const { events, emit } = collectBatches();
  const config = testConfig(emit);
  const handler = wrapMcpHandler(
    createMcpHandler(instrumentedFactory(() => buildEchoServer(), config)),
    config,
  );

  const client = legacyClient();
  const transport = inProcessTransport(handler, { [SESSION_SEED_HEADER]: SEED_B });
  await client.connect(transport);
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    // The wrapper repairs the SDK's silent legacy regression: createMcpHandler's
    // stateless legacy leg mints no Mcp-Session-Id of its own.
    const minted = transport.sessionId;
    assert.ok(minted, "wrapMcpHandler must mint a legacy session id at initialize");
    assert.equal(
      minted,
      `mcp_v2-legacy-client_v_1.0.0_${SEED_B}`,
      "id must carry the client identity and honor X-Armature-Session-Seed",
    );

    await client.callTool({ name: "echo", arguments: { msg: "legacy" } });

    const sessionInits = events().filter((e) => e.kind === "session_init");
    const toolCall = events().find((e) => e.kind === "tool_call");
    assert.equal(sessionInits.length, 1);
    // Client identity is recovered from the identity-bearing id even though
    // initialize landed on a throwaway per-request server instance.
    assert.equal(sessionInits[0]?.metadata.client_name, "v2-legacy-client");
    assert.equal(sessionInits[0]?.metadata.client_version, "1.0.0");
    assert.equal(sessionInits[0]?.session_id_hint, minted);
    // The echoed request header is rung 3 of the ladder for tool calls.
    assert.ok(toolCall);
    assert.equal(toolCall?.session_id_hint, minted);
    assert.equal(toolCall?.ok, true);
    // Legacy tool calls carry no per-request envelope: unknown client is the
    // documented steady state on this leg.
    assert.equal(toolCall?.metadata.client_name, undefined);
  } finally {
    await client.close();
  }
});

test("v2 legacy era without wrapMcpHandler: documented SDK behavior — no session id, null hints, no crash", async () => {
  const { events, emit } = collectBatches();
  const handler = createMcpHandler(
    instrumentedFactory(() => buildEchoServer(), testConfig(emit)),
  );

  const client = legacyClient();
  const transport = inProcessTransport(handler);
  await client.connect(transport);
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal(
      transport.sessionId,
      undefined,
      "createMcpHandler's legacy leg mints no Mcp-Session-Id",
    );
    const result = await client.callTool({ name: "echo", arguments: { msg: "bare" } });
    assert.equal((result.content as { text?: string }[])[0]?.text, "echo:bare");

    const toolCall = events().find((e) => e.kind === "tool_call");
    assert.ok(toolCall, "the call is still recorded");
    assert.equal(toolCall?.ok, true);
    assert.equal(toolCall?.session_id_hint, null);
    assert.equal(toolCall?.metadata.client_name, undefined);
    assert.equal(
      events().filter((e) => e.kind === "session_init").length,
      0,
      "no session key, no session_init",
    );
  } finally {
    await client.close();
  }
});

// ─── Direct wrapped-callback invocations (ladder permutations) ──────────────

// The wrapped callback the SDK would dispatch, straight from the registry —
// the only way to exercise ladder rungs that need a sessionful legacy
// transport (ctx.sessionId) or a stdio context (no HTTP at all).
const wrappedHandlerOf = (server: unknown, name: string) => {
  const registry = (server as { _registeredTools: Record<string, { handler: unknown }> })
    ._registeredTools;
  return registry[name]?.handler as (
    args: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

const httpCtx = (overrides: {
  sessionId?: string;
  _meta?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
  headers?: Record<string, string>;
  noHttp?: boolean;
}) => ({
  ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
  mcpReq: {
    id: 1,
    ...(overrides._meta !== undefined ? { _meta: overrides._meta } : {}),
    ...(overrides.envelope !== undefined ? { envelope: overrides.envelope } : {}),
  },
  ...(overrides.noHttp
    ? {}
    : {
        http: {
          req: new Request("http://in-process.local/mcp", {
            headers: overrides.headers ?? {},
          }),
        },
      }),
});

test("v2 session-id ladder: baggage beats seed beats legacy sessionId beats echoed header; stdio only without HTTP", async () => {
  const { events, batches, emit } = collectBatches();
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit));
  const handler = wrappedHandlerOf(server, "echo");

  const allSignals = {
    _meta: { baggage: "gen_ai.conversation.id=conv%2D1;prop=x,team=core" },
    headers: {
      [SESSION_SEED_HEADER]: SEED_A,
      "mcp-session-id": "echoed-legacy-id",
    },
    sessionId: "transport-session-1",
  };

  await handler({ msg: "a" }, httpCtx(allSignals));
  assert.equal(events().at(-1)?.session_id_hint, "conv-1", "rung 1: baggage wins");

  await handler({ msg: "b" }, httpCtx({ ...allSignals, _meta: {} }));
  assert.equal(events().at(-1)?.session_id_hint, SEED_A, "rung 2: seed header");

  await handler(
    { msg: "c" },
    httpCtx({ sessionId: "transport-session-1", headers: { "mcp-session-id": "echoed-legacy-id" } }),
  );
  assert.equal(
    events().at(-1)?.session_id_hint,
    "transport-session-1",
    "rung 3: legacy ctx.sessionId",
  );

  await handler({ msg: "d" }, httpCtx({ headers: { "mcp-session-id": "echoed-legacy-id" } }));
  assert.equal(
    events().at(-1)?.session_id_hint,
    "echoed-legacy-id",
    "rung 3b: the Mcp-Session-Id header a legacy client echoes",
  );

  // Rung 5: HTTP context present but no signal at all — hint stays null, and
  // the stdio fallback must NOT leak into HTTP traffic.
  await handler({ msg: "e" }, httpCtx({ headers: {} }));
  const nullHint = events()
    .filter((e) => e.kind === "tool_call")
    .at(-1);
  assert.equal(nullHint?.session_id_hint, null);

  // Rung 4: no HTTP context at all — the stdio process-scoped id.
  __resetProcessScopedSessionIdForTests();
  batches.length = 0;
  await handler({ msg: "f" }, httpCtx({ noHttp: true }));
  const stdioCall = events().find((e) => e.kind === "tool_call");
  assert.match(String(stdioCall?.session_id_hint), /^stdio-/);
  __resetProcessScopedSessionIdForTests();
});

test("v2 clientInfo-absent envelope: request is served and attributed to an unknown client", async () => {
  const { events, emit } = collectBatches();
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit));
  const handler = wrappedHandlerOf(server, "echo");

  // Final-spec minimum envelope: protocolVersion + clientCapabilities, no
  // clientInfo (it is a SHOULD). Must not crash and must not invent a name.
  await handler(
    { msg: "anon" },
    httpCtx({
      envelope: {
        [PROTOCOL_VERSION_KEY]: "2026-07-28",
        [CAPABILITIES_KEY]: {},
      },
      headers: { [SESSION_SEED_HEADER]: SEED_B },
    }),
  );

  const init = events().find((e) => e.kind === "session_init");
  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.ok(init);
  assert.ok(toolCall);
  assert.equal(init?.metadata.client_name, null, "unknown client stays null");
  assert.equal(init?.metadata.client_version, null);
  assert.equal(init?.metadata.protocol_version, "2026-07-28");
  assert.equal(toolCall?.metadata.client_name, undefined);
  assert.equal(toolCall?.metadata.protocol_version, "2026-07-28");
  assert.equal(toolCall?.ok, true);
});

test("v2 request_meta capture is intact below 4KB and truncated with a marker above it", async () => {
  const { events, batches, emit } = collectBatches();
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit));
  const handler = wrappedHandlerOf(server, "echo");

  const smallMeta = { traceparent: "00-abc-def-01", custom: { nested: true } };
  await handler({ msg: "s" }, httpCtx({ _meta: smallMeta, headers: {} }));
  let toolCall = events().find((e) => e.kind === "tool_call");
  assert.deepEqual(toolCall?.metadata.request_meta, smallMeta);
  assert.equal(toolCall?.metadata.request_meta_truncated, undefined);

  batches.length = 0;
  // Whitespace breaks the base64-run sanitizer pattern, so this stays a
  // genuinely large payload after sanitization and exercises the cap.
  const bigMeta = { payload: "word ".repeat(2_000), traceparent: "00-abc-def-01" };
  await handler({ msg: "b" }, httpCtx({ _meta: bigMeta, headers: {} }));
  toolCall = events().find((e) => e.kind === "tool_call");
  const captured = toolCall?.metadata.request_meta;
  assert.equal(typeof captured, "string", "over-cap _meta is captured as a capped string");
  assert.ok(Buffer.byteLength(String(captured), "utf8") <= 4 * 1024);
  assert.equal(toolCall?.metadata.request_meta_truncated, true);
});

test("v2 request_meta runs through the preview sanitization pipeline: secrets redacted, base64 blobs removed", async () => {
  const { events, batches, emit } = collectBatches();
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit));
  const handler = wrappedHandlerOf(server, "echo");

  const secret = "sk-abcdefghijklmnopqrstuvwx";
  const encoded = "A".repeat(600);
  await handler(
    { msg: "s" },
    httpCtx({
      _meta: { note: `token ${secret} end`, encoded, traceparent: "00-abc-def-01" },
      headers: {},
    }),
  );
  const toolCall = events().find((e) => e.kind === "tool_call");
  const captured = toolCall?.metadata.request_meta as Record<string, unknown>;
  assert.ok(isRecordLike(captured), "sub-cap sanitized _meta stays an object");
  assert.ok(
    !JSON.stringify(captured).includes(secret),
    "secrets in request _meta must be redacted before emit",
  );
  assert.match(String(captured.note), /\[redacted:openai-api-key\]/);
  assert.equal(captured.encoded, "[base64 removed]");
  assert.equal(captured.traceparent, "00-abc-def-01", "benign keys pass through");
  assert.equal(toolCall?.metadata.request_meta_truncated, undefined);

  // redactSecrets: false keeps the secret (customer opt-out), but base64
  // sanitization still applies.
  batches.length = 0;
  const { events: events2, emit: emit2 } = collectBatches();
  const server2 = withMcpAnalytics(
    buildEchoServer(),
    testConfig(emit2, { redactSecrets: false }),
  );
  const handler2 = wrappedHandlerOf(server2, "echo");
  await handler2(
    { msg: "s" },
    httpCtx({ _meta: { note: `token ${secret} end`, encoded }, headers: {} }),
  );
  const toolCall2 = events2().find((e) => e.kind === "tool_call");
  const captured2 = toolCall2?.metadata.request_meta as Record<string, unknown>;
  assert.match(String(captured2.note), new RegExp(secret));
  assert.equal(captured2.encoded, "[base64 removed]");
});

test("v2 owned telemetry field: a schema-declared telemetry property is never stripped or exported", async () => {
  const { events, emit } = collectBatches();
  let received: unknown;
  const server = new McpServer(
    { name: "v2-owned", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "owned_tool",
    {
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { msg: { type: "string" }, telemetry: { type: "object" } },
      }),
    },
    async (args: unknown) => {
      received = args;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );
  withMcpAnalytics(server, testConfig(emit));
  const handler = wrappedHandlerOf(server, "owned_tool");

  await handler(
    { msg: "m", telemetry: { user_intent: "customer-owned value" } },
    httpCtx({ headers: {} }),
  );

  assert.deepEqual(received, { msg: "m", telemetry: { user_intent: "customer-owned value" } });
  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.equal(
    toolCall?.metadata.user_intent,
    null,
    "owned-mode telemetry must never be exported as Armature telemetry",
  );
  assert.match(
    String(toolCall?.metadata.input_preview),
    /customer-owned value/,
    "the owned field stays part of the tool's own input",
  );
});

test("v2 wrap is idempotent and covers tools registered before AND after withMcpAnalytics", async () => {
  const { events, emit } = collectBatches();
  const server = buildEchoServer();
  const config = testConfig(emit);
  withMcpAnalytics(server, config);
  withMcpAnalytics(server, config); // double wrap must be a no-op

  server.registerTool(
    "late_tool",
    { inputSchema: ECHO_INPUT_SCHEMA },
    async (args: unknown) => ({
      content: [
        {
          type: "text" as const,
          text: `late:${(args as { msg?: string } | undefined)?.msg}`,
        },
      ],
    }),
  );

  const echo = wrappedHandlerOf(server, "echo");
  const late = wrappedHandlerOf(server, "late_tool");
  await echo({ msg: "1" }, httpCtx({ headers: {} }));
  await late({ msg: "2" }, httpCtx({ headers: {} }));

  const toolCalls = events().filter((e) => e.kind === "tool_call");
  assert.equal(toolCalls.length, 2, "each invocation records exactly once");
  assert.deepEqual(
    toolCalls.map((e) => e.metadata.tool_name),
    ["echo", "late_tool"],
  );
});

test("v2 no-schema tools keep the (ctx)-only callback arity and still record", async () => {
  const { events, emit } = collectBatches();
  const server = new McpServer(
    { name: "v2-noschema", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  let sawCtx: unknown;
  server.registerTool("ping", { description: "Liveness check" }, async (ctx: unknown) => {
    sawCtx = ctx;
    return { content: [{ type: "text" as const, text: "pong" }] };
  });
  withMcpAnalytics(server, testConfig(emit));

  const handler = wrappedHandlerOf(server, "ping") as unknown as (
    ctx: unknown,
  ) => Promise<unknown>;
  const ctx = httpCtx({ headers: {} });
  await handler(ctx);

  assert.equal(sawCtx, ctx, "the original callback must receive the ctx, not an args object");
  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.equal(toolCall?.metadata.tool_name, "ping");
  assert.equal(toolCall?.ok, true);
});

test("v2 on-the-wire clientInfo-absent modern request is served and recorded as an unknown client", async () => {
  // TS SDK 2.0.0 accepts a modern envelope with only protocolVersion +
  // clientCapabilities (clientInfo is a SHOULD in the final spec) — verified
  // here on the wire, because some other SDK builds 400 on the missing key.
  // Hand-rolled modern requests must mirror the SEP-2243 standard headers
  // (Mcp-Protocol-Version / Mcp-Method / Mcp-Name) or the server answers
  // -32020 HeaderMismatch.
  const { events, emit } = collectBatches();
  const handler = createMcpHandler(
    instrumentedFactory(() => buildEchoServer(), testConfig(emit)),
  );

  const response = await handler.fetch(
    new Request("http://in-process.local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "echo",
        [SESSION_SEED_HEADER]: SEED_B,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { msg: "anonymous" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    result?: { content?: { text?: string }[] };
    error?: unknown;
  };
  assert.equal(payload.error, undefined);
  assert.equal(payload.result?.content?.[0]?.text, "echo:anonymous");

  const toolCall = events().find((e) => e.kind === "tool_call");
  const init = events().find((e) => e.kind === "session_init");
  assert.ok(toolCall);
  assert.equal(toolCall?.metadata.client_name, undefined);
  assert.equal(toolCall?.metadata.protocol_version, "2026-07-28");
  assert.equal(toolCall?.session_id_hint, SEED_B);
  assert.equal(init?.metadata.client_name, null, "unknown client, not a crash");
});

test("v2 records a snapshot of the result: post-return _meta mutation (the SDK's serverInfo stamp) never reaches the preview", async () => {
  const { events, emit } = collectBatches();
  // Background delivery so the preview is built AFTER the call resolves —
  // the window in which the v2 SDK stamps serverInfo into the result's _meta.
  const config: McpAnalyticsConfig = {
    armature: { delivery: "background", actorId: "race-actor", emit },
  };
  const result: Record<string, unknown> = {
    content: [{ type: "text" as const, text: "ok" }],
    _meta: { original: true },
  };
  const server = new McpServer(
    { name: "v2-race", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "racer",
    { inputSchema: ECHO_INPUT_SCHEMA },
    async () => result as { content: { type: "text"; text: string }[] },
  );
  withMcpAnalytics(server, config);

  const handler = wrappedHandlerOf(server, "racer");
  const returned = await handler({ msg: "x" }, httpCtx({ headers: {} }));
  assert.equal(returned, result, "the live object is returned to the SDK untouched");
  // Simulate the SDK's post-return encode step.
  (result._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"] = {
    name: "stamped-after-return",
  };
  const { flushMcpAnalytics } = await import("../src/v2.js");
  await flushMcpAnalytics(config);

  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.ok(toolCall);
  assert.match(String(toolCall?.result_preview), /"original":true/);
  assert.ok(
    !String(toolCall?.result_preview).includes("stamped-after-return"),
    "the recorded preview must be the synchronous snapshot, not the mutated live object",
  );
});

// ─── protocol_era, metadata hook, capabilities, user_agent, authInfo ────────

test("v2 protocol_era metadata: envelope requests stamp modern, everything else legacy", async () => {
  const { events, emit } = collectBatches();
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit));
  const handler = wrappedHandlerOf(server, "echo");

  await handler(
    { msg: "m" },
    httpCtx({
      envelope: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CAPABILITIES_KEY]: {} },
      headers: {},
    }),
  );
  await handler({ msg: "l" }, httpCtx({ headers: {} }));

  const toolCalls = events().filter((e) => e.kind === "tool_call");
  assert.equal(toolCalls[0]?.metadata.protocol_era, "modern");
  assert.equal(toolCalls[1]?.metadata.protocol_era, "legacy");
});

test("v2 metadata hook: keys merge into tool_call metadata, beat adapter keys, lose to contract keys, and a throw is ignored", async () => {
  const { events, emit } = collectBatches();
  let hookCalls = 0;
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit), {
    metadata: (ctx) => {
      hookCalls += 1;
      assert.ok(isRecordLike(ctx), "the hook receives the handler ctx");
      return {
        deployment: "canary",
        protocol_era: "hook-override",
        tool_name: "hook-must-not-win",
      };
    },
  });
  const handler = wrappedHandlerOf(server, "echo");
  await handler({ msg: "m" }, httpCtx({ headers: {} }));

  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.equal(hookCalls, 1);
  assert.equal(toolCall?.metadata.deployment, "canary");
  assert.equal(
    toolCall?.metadata.protocol_era,
    "hook-override",
    "hook keys win over adapter-derived keys",
  );
  assert.equal(
    toolCall?.metadata.tool_name,
    "echo",
    "contract-defined keys always win over the hook",
  );

  const { events: events2, emit: emit2 } = collectBatches();
  const throwing = withMcpAnalytics(buildEchoServer(), testConfig(emit2), {
    metadata: () => {
      throw new Error("hook exploded");
    },
  });
  const throwingHandler = wrappedHandlerOf(throwing, "echo");
  const result = await throwingHandler({ msg: "ok" }, httpCtx({ headers: {} }));
  assert.ok(result, "a throwing hook must not break the tool call");
  const recorded = events2().find((e) => e.kind === "tool_call");
  assert.equal(recorded?.ok, true, "a throwing hook must not break recording");
});

test("v2 clientCapabilities ride tool_call metadata, dropped to null over the byte cap", async () => {
  const { events, batches, emit } = collectBatches();
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit));
  const handler = wrappedHandlerOf(server, "echo");

  const capabilities = { elicitation: {}, sampling: { maxTokens: 4096 } };
  await handler(
    { msg: "m" },
    httpCtx({
      envelope: {
        [PROTOCOL_VERSION_KEY]: "2026-07-28",
        [CAPABILITIES_KEY]: capabilities,
      },
      headers: {},
    }),
  );
  let toolCall = events().find((e) => e.kind === "tool_call");
  assert.deepEqual(toolCall?.metadata.capabilities, capabilities);

  batches.length = 0;
  await handler(
    { msg: "big" },
    httpCtx({
      envelope: {
        [PROTOCOL_VERSION_KEY]: "2026-07-28",
        [CAPABILITIES_KEY]: { blob: "c".repeat(5_000) },
      },
      headers: {},
    }),
  );
  toolCall = events().find((e) => e.kind === "tool_call");
  assert.equal(
    toolCall?.metadata.capabilities,
    null,
    "over-cap capabilities are dropped to null, same as session_init",
  );

  batches.length = 0;
  await handler({ msg: "none" }, httpCtx({ headers: {} }));
  toolCall = events().find((e) => e.kind === "tool_call");
  assert.equal(
    "capabilities" in (toolCall?.metadata ?? {}),
    false,
    "no envelope capabilities, no key",
  );
});

test("v2 user_agent is captured on session_init and tool_call metadata (e2e headers)", async () => {
  const { events, emit } = collectBatches();
  const handler = createMcpHandler(
    instrumentedFactory(() => buildEchoServer(), testConfig(emit)),
  );

  const client = modernClient();
  await client.connect(
    inProcessTransport(handler, {
      [SESSION_SEED_HEADER]: SEED_A,
      "user-agent": "armature-test-agent/1.2.3",
    }),
  );
  try {
    await client.callTool({ name: "echo", arguments: { msg: "ua" } });

    const init = events().find((e) => e.kind === "session_init");
    const toolCall = events().find((e) => e.kind === "tool_call");
    assert.equal(init?.metadata.user_agent, "armature-test-agent/1.2.3");
    assert.equal(toolCall?.metadata.user_agent, "armature-test-agent/1.2.3");
  } finally {
    await client.close();
  }
});

test("v2 user_agent falls back to the factory request context when the handler ctx has no HTTP request", async () => {
  const { events, emit } = collectBatches();
  const server = withMcpAnalytics(buildEchoServer(), testConfig(emit));
  const handler = wrappedHandlerOf(server, "echo");

  await handler(
    { msg: "m" },
    httpCtx({ headers: { "user-agent": "direct-ua/0.1", [SESSION_SEED_HEADER]: SEED_B } }),
  );
  const toolCall = events().find((e) => e.kind === "tool_call");
  const init = events().find((e) => e.kind === "session_init");
  assert.equal(toolCall?.metadata.user_agent, "direct-ua/0.1");
  assert.equal(init?.metadata.user_agent, "direct-ua/0.1");
});

test("v2 wrapMcpHandler forwards fetch-options authInfo into session_init actor resolution", async () => {
  const { events, emit } = collectBatches();
  const seenAuthInfo: unknown[] = [];
  const config: McpAnalyticsConfig = {
    armature: {
      delivery: "await",
      emit,
      actorId: (input) => {
        seenAuthInfo.push(input.authInfo);
        return input.authInfo?.clientId ?? "anonymous";
      },
    },
  };
  const handler = wrapMcpHandler(
    createMcpHandler(instrumentedFactory(() => buildEchoServer(), config)),
    config,
  );

  const response = await (handler.fetch as (
    request: Request,
    options?: unknown,
  ) => Promise<Response>)(
    new Request("http://in-process.local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-auth-client", version: "9.9.9" },
        },
      }),
    }),
    { authInfo: { clientId: "acme-tenant", token: "tok_forwarded" } },
  );
  assert.equal(response.ok, true);

  const init = events().find((e) => e.kind === "session_init");
  assert.ok(init, "legacy initialize records a session_init");
  assert.equal(seenAuthInfo.length >= 1, true, "the actor resolver ran");
  assert.deepEqual(
    seenAuthInfo[0],
    { clientId: "acme-tenant", token: "tok_forwarded" },
    "the fetch-options authInfo reaches the actor resolver (same shape as the tool-call path)",
  );
});

test("conversationIdFromBaggage parses list members, drops properties, URL-decodes, and rejects junk", () => {
  assert.equal(
    conversationIdFromBaggage("gen_ai.conversation.id=conv-7"),
    "conv-7",
  );
  assert.equal(
    conversationIdFromBaggage("a=b,gen_ai.conversation.id=conv%2F7;prop=1,c=d"),
    "conv/7",
  );
  assert.equal(conversationIdFromBaggage("a=b,c=d"), undefined);
  assert.equal(conversationIdFromBaggage("gen_ai.conversation.id="), undefined);
  assert.equal(conversationIdFromBaggage(42), undefined);
  assert.equal(conversationIdFromBaggage(undefined), undefined);
});
