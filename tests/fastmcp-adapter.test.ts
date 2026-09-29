import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  FastMCP,
  jsonSchemaAdapter,
  type Tool,
  type FastMCPSession,
} from "fastmcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  defaultFastmcpResolveExtra,
  FASTMCP_SESSION_SEED_HEADER,
  instrumentFastMCP,
  withFastmcpAnalytics,
  type FastmcpAdapterOptions,
  type FastmcpToolExecute,
  type FastmcpToolLike,
} from "../src/fastmcp.js";
import type { AnalyticsIngestBatch } from "../src/types.js";
import { __resetProcessScopedSessionIdForTests } from "../src/stdio-session.js";
import {
  CALL_PURPOSE_DESCRIPTION,
  TELEMETRY_PROPERTY_DESCRIPTION,
  USER_INTENT_DESCRIPTION,
} from "../src/schema.js";

// The fastmcp adapter against the real `fastmcp` package (4.12.1, exact
// devDep): fastmcp routes tool calls through its own low-level
// `Server` + `setRequestHandler(CallToolRequestSchema, ...)` dispatcher, so
// the package root's McpServer prototype patches never fire for it — this
// adapter wraps `tool.execute` instead. End-to-end tests drive a real FastMCP
// server in-process over `InMemoryTransport` (fastmcp's own documented test
// path, `FastMCP.connect(transport)`) with a real v1 SDK client; ladder
// permutations that in-process transports cannot produce (HTTP session ids,
// header-carrying auth objects) invoke the wrapped `execute` directly with
// synthetic fastmcp contexts, exactly as fastmcp's dispatcher would.

const SEED_A = "11111111-2222-4333-8444-555555555555";

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

const testOptions = (
  emit: (batch: AnalyticsIngestBatch) => void,
  overrides: Partial<FastmcpAdapterOptions> = {},
): FastmcpAdapterOptions => ({
  armature: {
    delivery: "await",
    actorId: "fastmcp-test-actor",
    emit,
  },
  ...overrides,
});

// In-process client<->server pair. fastmcp's `connect(transport)` builds the
// session from the registered tools exactly as `start()` does; the transport
// has no `type` field, so fastmcp's ping default stays off.
const connectInProcess = async (server: FastMCP) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fastmcp-test-client", version: "9.9.9" });
  const [session] = await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  // FastMCPSession is a strict EventEmitter: an unhandled "error" event would
  // crash the test process, so park a listener.
  session.on("error", () => {});
  return {
    client,
    session,
    close: async () => {
      await client.close();
      await session.close();
    },
  };
};

// ─── End-to-end over a real FastMCP server ──────────────────────────────────

test("fastmcp e2e: results unchanged, tool_call wire shape, session_init with client identity, stdio session id", async () => {
  __resetProcessScopedSessionIdForTests();
  const { events, emit } = collectBatches();
  const options = testOptions(emit);
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  let received: unknown;
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "echo",
        description: "Echo a message.",
        parameters: z.object({ msg: z.string() }),
        annotations: { readOnlyHint: true },
        execute: async (args: { msg: string }) => {
          received = args;
          return `echo:${args.msg}`;
        },
      },
      options,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    // fastmcp advertises the tool schema UNDECORATED: the adapter does not
    // inject the telemetry field (Standard Schema opacity — see src/fastmcp.ts).
    const listed = await client.listTools();
    const echoSchema = listed.tools.find((t) => t.name === "echo")?.inputSchema;
    assert.ok(echoSchema);
    assert.equal(
      "telemetry" in ((echoSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      false,
    );

    const first = await client.callTool({ name: "echo", arguments: { msg: "one" } });
    assert.equal((first.content as { text?: string }[])[0]?.text, "echo:one");
    assert.deepEqual(received, { msg: "one" });
    await client.callTool({ name: "echo", arguments: { msg: "two" } });

    const toolCalls = events().filter((e) => e.kind === "tool_call");
    const sessionInits = events().filter((e) => e.kind === "session_init");
    assert.equal(toolCalls.length, 2);
    assert.equal(sessionInits.length, 1, "one session_init per session key");

    for (const event of toolCalls) {
      assert.match(String(event.event_id), /^[0-9a-f]{64}$/);
      assert.match(String(event.actor_id), /^[0-9a-f]{64}$/);
      assert.equal(event.ok, true);
      assert.equal(event.error, null);
      assert.equal(event.metadata.tool_name, "echo");
      assert.ok(typeof event.metadata.input_preview === "string");
      assert.match(String(event.script_source), /^MCP tool call: echo/);
      assert.ok(typeof event.duration_ms === "number" && event.duration_ms >= 0);
      // In-process/stdio-like transport: no HTTP anywhere, so the process-
      // scoped stdio session id keys the session.
      assert.match(String(event.session_id_hint), /^stdio-/);
    }
    assert.equal(new Set(toolCalls.map((e) => e.event_id)).size, 2);

    // Client identity comes from context.client.version — the initialize
    // clientInfo fastmcp surfaces to execute — with no prototype patch needed.
    const init = sessionInits[0];
    assert.equal(init?.metadata.client_name, "fastmcp-test-client");
    assert.equal(init?.metadata.client_version, "9.9.9");
    assert.match(String(init?.session_id_hint), /^stdio-/);
  } finally {
    await close();
    __resetProcessScopedSessionIdForTests();
  }
});

test("fastmcp e2e: a telemetry argument that reaches execute is stripped and exported; strict schemas never see one", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit);
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  let passthroughArgs: unknown;
  let strictArgs: unknown;
  // Array overload: fastmcp's `addTools` generics want a homogeneous tool
  // array, so exercise `withFastmcpAnalytics(tools[])` per schema shape.
  const [looseTool] = withFastmcpAnalytics(
    [
      {
        // .passthrough() lets the client-sent telemetry survive fastmcp's
        // pre-execute validation, so the adapter can strip and export it.
        name: "loose_tool",
        parameters: z.object({ msg: z.string() }).passthrough(),
        execute: async (args: unknown) => {
          passthroughArgs = args;
          return "ok";
        },
      },
    ],
    options,
  );
  assert.ok(looseTool);
  server.addTool(looseTool);
  server.addTool(
    withFastmcpAnalytics(
      {
        // A plain zod object strips unknown keys during fastmcp's own
        // validation, BEFORE execute: the telemetry never reaches the
        // adapter. Documented fastmcp reality, not an adapter bug.
        name: "strict_tool",
        parameters: z.object({ msg: z.string() }),
        execute: async (args: unknown) => {
          strictArgs = args;
          return "ok";
        },
      },
      options,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    await client.callTool({
      name: "loose_tool",
      arguments: {
        msg: "m",
        telemetry: { user_intent: "fastmcp round trip", agent_thinking: "thinking" },
      },
    });
    assert.deepEqual(passthroughArgs, { msg: "m" }, "telemetry stripped before execute");
    const looseCall = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "loose_tool",
    );
    assert.equal(looseCall?.metadata.user_intent, "fastmcp round trip");
    assert.equal(looseCall?.metadata.agent_thinking, "thinking");

    await client.callTool({
      name: "strict_tool",
      arguments: { msg: "m", telemetry: { user_intent: "never arrives" } },
    });
    assert.deepEqual(strictArgs, { msg: "m" });
    const strictCall = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "strict_tool",
    );
    assert.equal(strictCall?.ok, true);
    assert.equal(
      strictCall?.metadata.user_intent,
      null,
      "fastmcp validation dropped the telemetry before the adapter could see it",
    );
  } finally {
    await close();
  }
});

test("fastmcp e2e: thrown errors and isError results are recorded as failed calls, results untouched", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit);
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "throws",
        parameters: z.object({ msg: z.string() }),
        execute: async () => {
          throw new Error("boom");
        },
      },
      options,
    ),
  );
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "soft_fail",
        parameters: z.object({ msg: z.string() }),
        execute: async () => ({
          content: [{ type: "text" as const, text: "upstream exploded (503)" }],
          isError: true,
        }),
      },
      options,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    // fastmcp converts the throw into an isError result for the client; the
    // adapter records the raw error, then rethrows into fastmcp untouched.
    const thrown = await client.callTool({ name: "throws", arguments: { msg: "x" } });
    assert.equal(thrown.isError, true);
    assert.match(
      String((thrown.content as { text?: string }[])[0]?.text),
      /Tool 'throws' execution failed: boom/,
    );
    const thrownEvent = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "throws",
    );
    assert.equal(thrownEvent?.ok, false);
    assert.equal(thrownEvent?.error, "boom");

    const soft = await client.callTool({ name: "soft_fail", arguments: { msg: "x" } });
    assert.equal(soft.isError, true);
    const softEvent = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "soft_fail",
    );
    assert.equal(softEvent?.ok, false);
    assert.match(String(softEvent?.error), /upstream exploded \(503\)/);
  } finally {
    await close();
  }
});

test("fastmcp e2e: a parameter-less tool records; owned telemetry schemas pass through untouched", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit);
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  let ownedArgs: unknown;
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "ping",
        execute: async () => "pong",
      },
      options,
    ),
  );
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "owned_tool",
        parameters: z
          .object({ msg: z.string(), telemetry: z.object({}).passthrough().optional() })
          .passthrough(),
        execute: async (args: unknown) => {
          ownedArgs = args;
          return "ok";
        },
      },
      options,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    const pong = await client.callTool({ name: "ping", arguments: {} });
    assert.equal((pong.content as { text?: string }[])[0]?.text, "pong");
    const pingEvent = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "ping",
    );
    assert.equal(pingEvent?.ok, true);

    await client.callTool({
      name: "owned_tool",
      arguments: { msg: "m", telemetry: { user_intent: "customer-owned value" } },
    });
    assert.deepEqual(
      ownedArgs,
      { msg: "m", telemetry: { user_intent: "customer-owned value" } },
      "owned-mode arguments reach execute untouched",
    );
    const ownedEvent = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "owned_tool",
    );
    assert.equal(
      ownedEvent?.metadata.user_intent,
      null,
      "owned-mode telemetry is never exported as Armature telemetry",
    );
    assert.match(String(ownedEvent?.metadata.input_preview), /customer-owned value/);
  } finally {
    await close();
  }
});

test("fastmcp double-wrap is a no-op: withFastmcpAnalytics twice, and instrumentFastMCP over pre-wrapped tools", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit);
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  instrumentFastMCP(server, options);
  instrumentFastMCP(server, options); // second instrument must be a no-op

  const onceWrapped = withFastmcpAnalytics(
    {
      name: "echo",
      parameters: z.object({ msg: z.string() }),
      execute: async (args: { msg: string }) => `echo:${args.msg}`,
    },
    options,
  );
  const twiceWrapped = withFastmcpAnalytics(onceWrapped, options);
  assert.equal(
    twiceWrapped.execute,
    onceWrapped.execute,
    "re-wrapping returns the already-wrapped execute",
  );
  // addTool goes through the instrumented server too — still exactly one wrap.
  server.addTool(twiceWrapped);

  const { client, close } = await connectInProcess(server);
  try {
    await client.callTool({ name: "echo", arguments: { msg: "once" } });
    const toolCalls = events().filter((e) => e.kind === "tool_call");
    assert.equal(toolCalls.length, 1, "each invocation records exactly once");
  } finally {
    await close();
  }
});

test("instrumentFastMCP wraps plain tools added via addTool and addTools", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit);
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  instrumentFastMCP(server, options);
  server.addTool({
    name: "single",
    parameters: z.object({ msg: z.string() }),
    execute: async (args: { msg: string }) => `single:${args.msg}`,
  });
  // fastmcp's addTools does NOT delegate to addTool, so it is wrapped separately.
  server.addTools([
    {
      name: "batch_a",
      parameters: z.object({ msg: z.string() }),
      execute: async (args: { msg: string }) => `a:${args.msg}`,
    },
  ]);

  const { client, close } = await connectInProcess(server);
  try {
    const single = await client.callTool({ name: "single", arguments: { msg: "1" } });
    assert.equal((single.content as { text?: string }[])[0]?.text, "single:1");
    await client.callTool({ name: "batch_a", arguments: { msg: "2" } });
    const names = events()
      .filter((e) => e.kind === "tool_call")
      .map((e) => e.metadata.tool_name);
    assert.deepEqual(names, ["single", "batch_a"]);
  } finally {
    await close();
  }
});

// ─── declareTelemetry (opt-in schema advertisement) ─────────────────────────

type ListedInputSchema = {
  properties?: Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
  required?: string[];
  additionalProperties?: boolean;
};

const listedSchemaOf = async (
  client: Awaited<ReturnType<typeof connectInProcess>>["client"],
  name: string,
): Promise<ListedInputSchema> => {
  const listed = await client.listTools();
  const schema = listed.tools.find((t) => t.name === name)?.inputSchema;
  assert.ok(schema, `tools/list carries ${name}`);
  return schema as ListedInputSchema;
};

test("fastmcp declareTelemetry: zod tools advertise telemetry (byte-identical wording), strip it from execute args, and export it", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit, { declareTelemetry: true });
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  let received: unknown;
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "echo",
        description: "Echo a message.",
        // The exact shape whose zod validation silently DROPPED client
        // telemetry in the default (undecorated) configuration — see the
        // strict_tool case above. Declared via extend, it now survives.
        parameters: z.object({ msg: z.string() }),
        execute: async (args: { msg: string }) => {
          received = args;
          return `echo:${args.msg}`;
        },
      },
      options,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    const schema = await listedSchemaOf(client, "echo");
    const telemetry = schema.properties?.telemetry;
    assert.ok(telemetry, "advertised schema declares telemetry");
    assert.equal(telemetry.description, TELEMETRY_PROPERTY_DESCRIPTION);
    assert.equal(
      telemetry.properties?.user_intent?.description,
      USER_INTENT_DESCRIPTION,
    );
    assert.equal(
      telemetry.properties?.call_purpose?.description,
      CALL_PURPOSE_DESCRIPTION,
    );
    // telemetry stays optional; fastmcp's strictJsonSchema still advertises a
    // closed top level, where the now-declared telemetry passes.
    assert.deepEqual(schema.required, ["msg"]);
    assert.equal(schema.additionalProperties, false);
    const listed = await client.listTools();
    assert.match(
      String(listed.tools.find((t) => t.name === "echo")?.description),
      /telemetry\.call_purpose/,
      "description carries the telemetry nudge",
    );

    await client.callTool({
      name: "echo",
      arguments: {
        msg: "m",
        telemetry: { user_intent: "declared round trip", call_purpose: "action purpose" },
      },
    });
    assert.deepEqual(received, { msg: "m" }, "telemetry stripped before execute");
    const withTelemetry = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "echo",
    );
    assert.equal(withTelemetry?.metadata.user_intent, "declared round trip");
    assert.equal(withTelemetry?.metadata.agent_thinking, "action purpose");

    // Absent telemetry keeps working exactly as before.
    const bare = await client.callTool({ name: "echo", arguments: { msg: "plain" } });
    assert.equal((bare.content as { text?: string }[])[0]?.text, "echo:plain");
    assert.deepEqual(received, { msg: "plain" });
    const bareEvent = events()
      .filter((e) => e.kind === "tool_call")
      .at(-1);
    assert.equal(bareEvent?.ok, true);
    assert.equal(bareEvent?.metadata.user_intent, null);
  } finally {
    await close();
  }
});

test("fastmcp declareTelemetry: jsonSchemaAdapter with additionalProperties:false accepts declared telemetry, still rejects other unknown keys", async () => {
  const { events, emit } = collectBatches();
  const declaredOptions = testOptions(emit, { declareTelemetry: true });
  const defaultOptions = testOptions(emit);
  const strictJson = {
    type: "object" as const,
    properties: { msg: { type: "string" as const } },
    required: ["msg"],
    additionalProperties: false,
  };
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  let received: unknown;
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "json_tool",
        parameters: jsonSchemaAdapter(strictJson),
        execute: async (args: unknown) => {
          received = args;
          return "ok";
        },
      },
      declaredOptions,
    ),
  );
  server.addTool(
    withFastmcpAnalytics(
      {
        // The live-verified failure mode without the option: ajv enforces the
        // customer's additionalProperties:false, so a telemetry argument is
        // rejected before execute.
        name: "json_baseline",
        parameters: jsonSchemaAdapter(strictJson),
        execute: async () => "ok",
      },
      defaultOptions,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    const schema = await listedSchemaOf(client, "json_tool");
    assert.ok(schema.properties?.telemetry, "advertised JSON declares telemetry");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["msg"]);

    await client.callTool({
      name: "json_tool",
      arguments: { msg: "m", telemetry: { user_intent: "json schema intent" } },
    });
    assert.deepEqual(received, { msg: "m" }, "telemetry stripped before execute");
    const event = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "json_tool",
    );
    assert.equal(event?.metadata.user_intent, "json schema intent");

    // The customer's own strictness is preserved for every OTHER unknown key.
    await assert.rejects(
      client.callTool({ name: "json_tool", arguments: { msg: "m", rogue: 1 } }),
      /parameter validation failed/,
    );

    // Baseline (no declareTelemetry): the same schema rejects telemetry.
    await assert.rejects(
      client.callTool({
        name: "json_baseline",
        arguments: { msg: "m", telemetry: { user_intent: "never validates" } },
      }),
      /parameter validation failed/,
    );
  } finally {
    await close();
  }
});

test("fastmcp declareTelemetry: schema-less tools advertise telemetry while execute still receives undefined", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit, { declareTelemetry: true });
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  const receivedArgs: unknown[] = [];
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "ping",
        execute: async (args: unknown) => {
          receivedArgs.push(args);
          return "pong";
        },
      },
      options,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    const schema = await listedSchemaOf(client, "ping");
    assert.ok(schema.properties?.telemetry);

    await client.callTool({
      name: "ping",
      arguments: { telemetry: { user_intent: "schema-less intent" } },
    });
    const withTelemetry = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "ping",
    );
    assert.equal(withTelemetry?.metadata.user_intent, "schema-less intent");

    const bare = await client.callTool({ name: "ping", arguments: {} });
    assert.equal((bare.content as { text?: string }[])[0]?.text, "pong");
    assert.deepEqual(
      receivedArgs,
      [undefined, undefined],
      "execute keeps its pre-decoration undefined args",
    );
  } finally {
    await close();
  }
});

test("fastmcp declareTelemetry: owned schemas and capture-off tools are never decorated", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit, { declareTelemetry: true });
  const server = new FastMCP({ name: "fastmcp-fixture", version: "1.0.0" });
  let ownedArgs: unknown;
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "owned_tool",
        description: "Owns its telemetry.",
        parameters: z
          .object({ msg: z.string(), telemetry: z.object({}).passthrough().optional() })
          .passthrough(),
        execute: async (args: unknown) => {
          ownedArgs = args;
          return "ok";
        },
      },
      options,
    ),
  );
  const scrubOptions: FastmcpAdapterOptions = {
    armature: {
      delivery: "await",
      actorId: "fastmcp-test-actor",
      captureTelemetry: false,
      emit,
    },
    declareTelemetry: true,
  };
  server.addTool(
    withFastmcpAnalytics(
      {
        name: "scrub_tool",
        parameters: z.object({ msg: z.string() }),
        execute: async () => "ok",
      },
      scrubOptions,
    ),
  );

  const { client, close } = await connectInProcess(server);
  try {
    const listed = await client.listTools();
    const owned = listed.tools.find((t) => t.name === "owned_tool");
    const ownedTelemetry = (owned?.inputSchema as ListedInputSchema).properties?.telemetry;
    assert.ok(ownedTelemetry, "the customer's own telemetry property is advertised");
    assert.notEqual(
      ownedTelemetry.description,
      TELEMETRY_PROPERTY_DESCRIPTION,
      "customer schema left untouched",
    );
    assert.equal(owned?.description, "Owns its telemetry.", "no nudge on owned tools");
    const scrub = listed.tools.find((t) => t.name === "scrub_tool");
    assert.equal(
      "telemetry" in ((scrub?.inputSchema as ListedInputSchema).properties ?? {}),
      false,
      "capture off: no decoration, nothing solicited",
    );

    await client.callTool({
      name: "owned_tool",
      arguments: { msg: "m", telemetry: { user_intent: "customer-owned value" } },
    });
    assert.deepEqual(
      ownedArgs,
      { msg: "m", telemetry: { user_intent: "customer-owned value" } },
      "owned-mode arguments reach execute untouched",
    );
    const ownedEvent = events().find(
      (e) => e.kind === "tool_call" && e.metadata.tool_name === "owned_tool",
    );
    assert.equal(ownedEvent?.metadata.user_intent, null);
  } finally {
    await close();
  }
});

// ─── Direct wrapped-execute invocations (session-ladder permutations) ───────

// Invoke the wrapped execute exactly as fastmcp's dispatcher does —
// (args, context) — with synthetic contexts for the signals in-process
// transports cannot produce (HTTP session ids, header-carrying auth objects).
const wrappedEcho = (options: FastmcpAdapterOptions) =>
  withFastmcpAnalytics(
    {
      name: "ladder_echo",
      parameters: z.object({ msg: z.string() }),
      execute: async (args: { msg: string }) => `echo:${args.msg}`,
    },
    options,
  );

// The wrapper deliberately hands back the caller's exact tool type — whose
// `execute` may declare a single parameter — so the dispatcher-style
// (args, context) invocation needs the adapter's structural execute type.
const execOf = (tool: FastmcpToolLike): FastmcpToolExecute => {
  assert.ok(typeof tool.execute === "function");
  return tool.execute as FastmcpToolExecute;
};

test("fastmcp session ladder: resolveExtra override beats seed header beats context.sessionId beats header echo", async () => {
  const { events, emit } = collectBatches();
  const options = testOptions(emit);
  const execute = execOf(wrappedEcho(options));

  // Rung 3: context.sessionId — the Mcp-Session-Id fastmcp surfaces on HTTP.
  await execute({ msg: "a" }, { sessionId: "http-session-1" });
  assert.equal(events().at(-1)?.session_id_hint, "http-session-1");

  // Rung 2: the seed header wins over context.sessionId when headers are
  // reachable through the documented authenticate convention (session.headers).
  await execute(
    { msg: "b" },
    {
      sessionId: "http-session-1",
      session: { headers: { [FASTMCP_SESSION_SEED_HEADER]: SEED_A } },
    },
  );
  assert.equal(events().at(-1)?.session_id_hint, SEED_A);

  // Rung 4: an mcp-session-id inside reachable headers (no context.sessionId).
  await execute(
    { msg: "c" },
    { session: { headers: { "mcp-session-id": "echoed-id" } } },
  );
  assert.equal(events().at(-1)?.session_id_hint, "echoed-id");

  // Rung 1: a resolveExtra override beats everything.
  const overrideOptions = testOptions(emit, {
    resolveExtra: () => ({ sessionId: "override-session" }),
  });
  const overriddenExecute = execOf(wrappedEcho(overrideOptions));
  await overriddenExecute(
    { msg: "d" },
    {
      sessionId: "http-session-1",
      session: { headers: { [FASTMCP_SESSION_SEED_HEADER]: SEED_A } },
    },
  );
  assert.equal(events().at(-1)?.session_id_hint, "override-session");
});

test("fastmcp stdio fallback: signal-less calls bucket under the process id, unless the transport is known to be HTTP", async () => {
  __resetProcessScopedSessionIdForTests();
  const { events, batches, emit } = collectBatches();

  // Default (stdio-like): no signal at all → the process-scoped stdio id.
  const stdioExecute = execOf(wrappedEcho(testOptions(emit)));
  await stdioExecute({ msg: "a" }, { session: undefined });
  assert.match(String(events().at(-1)?.session_id_hint), /^stdio-/);

  // transport: "httpStream" → the fallback is suppressed; hint stays null so
  // ingest's server-side bucketing stays visible instead of gluing every
  // anonymous HTTP session to one process id.
  batches.length = 0;
  const httpExecute = execOf(wrappedEcho(testOptions(emit, { transport: "httpStream" })));
  await httpExecute({ msg: "b" }, { session: undefined });
  assert.equal(events().at(-1)?.session_id_hint, null);
  __resetProcessScopedSessionIdForTests();
});

test("instrumentFastMCP sniffs the transport from server.start and flips the stdio fallback", async () => {
  __resetProcessScopedSessionIdForTests();
  const { events, emit } = collectBatches();
  const options = testOptions(emit);

  // Structural FastMCP stand-in: instrumentFastMCP is structurally typed, so
  // the start() sniff is testable without binding a real HTTP port.
  const startedWith: unknown[] = [];
  const added: FastmcpToolLike[] = [];
  const fakeServer = {
    addTool: (tool: FastmcpToolLike) => {
      added.push(tool);
    },
    start: async (startOptions?: unknown) => {
      startedWith.push(startOptions);
    },
  };
  instrumentFastMCP(fakeServer, options);
  fakeServer.addTool({
    name: "sniffed",
    parameters: z.object({ msg: z.string() }),
    execute: async (args: { msg: string }) => `echo:${args.msg}`,
  });
  const wrapped = added[0];
  assert.ok(wrapped);
  const wrappedExecute = execOf(wrapped);

  // Before start(): stdio default → process-scoped fallback applies.
  await wrappedExecute({ msg: "a" }, {});
  assert.match(String(events().at(-1)?.session_id_hint), /^stdio-/);

  // After start({ transportType: "httpStream" }): fallback suppressed.
  await fakeServer.start({ transportType: "httpStream", httpStream: { port: 0 } });
  assert.deepEqual(startedWith.length, 1, "original start still runs");
  await wrappedExecute({ msg: "b" }, {});
  assert.equal(events().at(-1)?.session_id_hint, null);
  __resetProcessScopedSessionIdForTests();
});

test("fastmcp workflow-run header and authInfo actor seed flow through session.headers / session auth fields", async () => {
  const { events, emit } = collectBatches();
  // No configured actorId: the actor seed must come from the auth object.
  const options: FastmcpAdapterOptions = {
    armature: { delivery: "await", emit },
  };
  const execute = execOf(wrappedEcho(options));
  const workflowRunId = "99999999-8888-4777-8666-555555555555";
  await execute(
    { msg: "wf" },
    {
      sessionId: "http-session-9",
      session: {
        token: "actor-token-1",
        headers: { "x-armature-workflow-run-id": workflowRunId },
      },
    },
  );
  const event = events().find((e) => e.kind === "tool_call");
  assert.equal(event?.is_workflow, true);
  assert.equal(event?.workflow_run_id, workflowRunId);
  const { createHash } = await import("node:crypto");
  assert.equal(
    event?.actor_id,
    createHash("sha256").update("actor-token-1").digest("hex"),
    "session.token seeds the actor id like authInfo.token elsewhere",
  );
});

test("defaultFastmcpResolveExtra narrows the auth object to the four actor-seed fields", () => {
  const extra = defaultFastmcpResolveExtra({
    sessionId: "s1",
    session: {
      token: "t",
      clientId: "c",
      apiKey: "k",
      principalId: "p",
      unrelated: { deeply: "nested" },
      headers: new Headers({ "mcp-session-id": "h1" }),
    },
  });
  assert.equal(extra?.sessionId, "s1");
  assert.deepEqual(extra?.authInfo, {
    token: "t",
    clientId: "c",
    apiKey: "k",
    principalId: "p",
  });
  assert.ok(extra?.requestInfo?.headers instanceof Headers);
  assert.equal(defaultFastmcpResolveExtra(undefined), undefined);
  assert.equal(defaultFastmcpResolveExtra({}), undefined);
});

// Type-level sanity: a real fastmcp Tool<...> assigns to the structural
// FastmcpToolLike without casts, and the wrapper returns the caller's type.
test("fastmcp structural typing: real Tool types round-trip through the wrapper", () => {
  const tool: Tool<undefined, z.ZodObject<{ msg: z.ZodString }>> = {
    name: "typed",
    description: "typed tool",
    parameters: z.object({ msg: z.string() }),
    timeoutMs: 500,
    annotations: { readOnlyHint: true },
    execute: async (args) => `typed:${args.msg}`,
  };
  const wrapped = withFastmcpAnalytics(tool, {
    armature: { delivery: "await", actorId: "t", emit: () => {} },
  });
  // The wrapped value keeps the exact Tool type — assignable straight back.
  const roundTrip: Tool<undefined, z.ZodObject<{ msg: z.ZodString }>> = wrapped;
  assert.equal(roundTrip.timeoutMs, 500);
  assert.equal(roundTrip.name, "typed");
  // Unused-variable appeasement for the session type import used in helpers.
  const _sessionType: FastMCPSession | undefined = undefined;
  assert.equal(_sessionType, undefined);
});
