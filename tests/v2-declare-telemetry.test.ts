import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as zv4 from "zod/v4";
import {
  instrumentedFactory,
  SESSION_SEED_HEADER,
  withMcpAnalytics,
  type AnalyticsIngestBatch,
  type McpAnalyticsConfig,
} from "../src/v2.js";
import {
  CALL_PURPOSE_DESCRIPTION,
  TELEMETRY_PROPERTY_DESCRIPTION,
  USER_INTENT_DESCRIPTION,
} from "../src/schema.js";

// Gap 1 of the v2 adapter: opt-in `declareTelemetry` decoration of ADVERTISED
// tool schemas, proven end to end against a real `createMcpHandler` +
// @modelcontextprotocol/client 2.0.0 pair. The mechanism under test: the
// adapter rebuilds each tool's schema from the SDK's own JSON conversion
// (`toolInputSchemaJson`) plus the v1 telemetry property, wraps it with
// `fromJsonSchema`, and swaps it in via `RegisteredTool.update({ paramsSchema })`
// — so the SDK's pre-wrapper Ajv validation accepts `telemetry`, `tools/list`
// advertises it (byte-identical descriptions to v1), and the analytics
// wrapper strips it before the customer callback runs.

const SEED = "11111111-2222-4333-8444-555555555555";

// The workspace's zod (v4 build of the 3.25 line) predates the compile-time
// `~standard.jsonSchema` declaration the SDK's `StandardSchemaWithJSON` type
// requires, though the SDK converts it fine at runtime (its own z.toJSONSchema
// fallback). Cast for the type checker only.
const asInputSchema = (schema: unknown) => schema as ReturnType<typeof fromJsonSchema>;

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
    actorId: "v2-declare-actor",
    emit,
    ...overrides,
  },
});

type ToolSchema = {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: unknown;
};

type ListedTool = {
  name: string;
  description?: string;
  inputSchema?: ToolSchema;
};

const telemetryPropertyOf = (tool: ListedTool | undefined) => {
  return tool?.inputSchema?.properties?.telemetry as
    | {
        type?: string;
        description?: string;
        properties?: Record<string, { type?: string; description?: string }>;
      }
    | undefined;
};

// Records what each customer callback actually received.
const buildFixtureServer = (received: Record<string, unknown[]>) => {
  const track = (name: string, value: unknown) => {
    (received[name] ??= []).push(value);
  };
  const server = new McpServer(
    { name: "declare-fixture", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "zecho",
    {
      description: "Echo a message.",
      inputSchema: asInputSchema(zv4.object({ msg: zv4.string() })),
    },
    async (args: unknown, _ctx: unknown) => {
      track("zecho", args);
      return {
        content: [
          { type: "text" as const, text: `zecho:${(args as { msg: string }).msg}` },
        ],
      };
    },
  );
  server.registerTool(
    "strict_echo",
    {
      description: "Strict echo.",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
        additionalProperties: false,
      }),
    },
    async (args: unknown, _ctx: unknown) => {
      track("strict_echo", args);
      return { content: [{ type: "text" as const, text: "strict:ok" }] };
    },
  );
  server.registerTool("ping", { description: "Liveness check." }, async (ctx: unknown) => {
    track("ping", ctx);
    return { content: [{ type: "text" as const, text: "pong" }] };
  });
  server.registerTool(
    "owned_tool",
    {
      description: "Customer owns telemetry.",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { msg: { type: "string" }, telemetry: { type: "object" } },
      }),
    },
    async (args: unknown, _ctx: unknown) => {
      track("owned_tool", args);
      return { content: [{ type: "text" as const, text: "owned:ok" }] };
    },
  );
  return server;
};

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
    { name: "declare-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );

test("declareTelemetry end to end: advertised schemas carry the v1 telemetry property, calls strip+export it, calls without it still work", async () => {
  const { events, emit } = collectBatches();
  const received: Record<string, unknown[]> = {};
  const handler = createMcpHandler(
    instrumentedFactory(
      () => buildFixtureServer(received),
      testConfig(emit),
      { declareTelemetry: true },
    ),
  );

  const client = modernClient();
  await client.connect(
    inProcessTransport(handler, { [SESSION_SEED_HEADER]: SEED }),
  );
  try {
    // ── tools/list: the ADVERTISED schema shows telemetry, byte-identical to v1
    const { tools } = (await client.listTools()) as { tools: ListedTool[] };
    const byName = new Map(tools.map((t) => [t.name, t]));
    const registeredDescriptions: Record<string, string> = {
      zecho: "Echo a message.",
      strict_echo: "Strict echo.",
      ping: "Liveness check.",
    };

    for (const name of ["zecho", "strict_echo", "ping"]) {
      const telemetry = telemetryPropertyOf(byName.get(name));
      assert.ok(telemetry, `${name} must advertise the telemetry property`);
      assert.equal(telemetry.type, "object");
      assert.equal(
        telemetry.description,
        TELEMETRY_PROPERTY_DESCRIPTION,
        `${name}: telemetry object description must be byte-identical to v1`,
      );
      assert.equal(
        telemetry.properties?.user_intent?.description,
        USER_INTENT_DESCRIPTION,
      );
      assert.equal(
        telemetry.properties?.call_purpose?.description,
        CALL_PURPOSE_DESCRIPTION,
      );
      assert.deepEqual(
        Object.keys(telemetry.properties ?? {}),
        ["user_intent", "call_purpose"],
        `${name}: user_frustration is no longer advertised`,
      );
      assert.equal(
        byName.get(name)?.description,
        registeredDescriptions[name],
        `${name}: the SDK never adds text to the description`,
      );
    }

    // The customer's own schema constraints survive decoration untouched.
    const strict = byName.get("strict_echo");
    assert.equal(
      strict?.inputSchema?.additionalProperties,
      false,
      "additionalProperties:false must stay on the advertised schema",
    );
    assert.deepEqual(strict?.inputSchema?.required, ["msg"]);
    assert.equal(strict?.inputSchema?.properties?.msg?.type, "string");

    // An owned schema is never re-decorated and keeps its description.
    const owned = byName.get("owned_tool");
    assert.equal(telemetryPropertyOf(owned)?.description, undefined);
    assert.equal(owned?.description, "Customer owns telemetry.");

    // ── call WITH telemetry: pre-wrapper Ajv validation accepts it, the
    // wrapper strips it from customer args and exports it as armature-owned.
    const withTelemetry = await client.callTool({
      name: "zecho",
      arguments: {
        msg: "hello",
        telemetry: {
          user_intent: "declared round trip",
          call_purpose: "probing decoration",
          // Sent by a client holding a cached schema: accepted, then dropped.
          user_frustration: "high",
        },
      },
    });
    assert.equal(withTelemetry.isError, undefined);
    assert.equal(
      (withTelemetry.content as { text?: string }[])[0]?.text,
      "zecho:hello",
    );
    assert.deepEqual(
      received.zecho?.[0],
      { msg: "hello" },
      "telemetry must be stripped before the customer callback",
    );
    let toolCall = events().filter((e) => e.kind === "tool_call").at(-1);
    assert.equal(toolCall?.metadata.tool_name, "zecho");
    assert.equal(
      toolCall?.metadata.user_intent,
      "declared round trip",
      "adapter-declared telemetry resolves armature-owned: exported",
    );
    assert.equal(toolCall?.metadata.agent_thinking, "probing decoration");
    assert.equal(toolCall?.metadata.user_frustration, null);
    assert.equal(toolCall?.metadata.frustration_level, null);
    assert.ok(
      !String(toolCall?.metadata.input_preview).includes("declared round trip"),
      "stripped telemetry must not leak into the input preview",
    );

    // ── call WITHOUT telemetry still works.
    const bare = await client.callTool({ name: "zecho", arguments: { msg: "bare" } });
    assert.equal(bare.isError, undefined);
    assert.equal((bare.content as { text?: string }[])[0]?.text, "zecho:bare");
    toolCall = events().filter((e) => e.kind === "tool_call").at(-1);
    assert.equal(toolCall?.metadata.user_intent, null);

    // ── additionalProperties:false + telemetry: accepted (declared property)…
    const strictCall = await client.callTool({
      name: "strict_echo",
      arguments: { msg: "s", telemetry: { user_intent: "strict intent" } },
    });
    assert.equal(strictCall.isError, undefined);
    assert.deepEqual(received.strict_echo?.[0], { msg: "s" });
    toolCall = events().filter((e) => e.kind === "tool_call").at(-1);
    assert.equal(toolCall?.metadata.user_intent, "strict intent");

    // …while any OTHER undeclared key is still rejected before the handler,
    // exactly as the customer's schema demands.
    const rejected = await client.callTool({
      name: "strict_echo",
      arguments: { msg: "s", bogus: true },
    });
    assert.equal(rejected.isError, true);
    assert.match(
      String((rejected.content as { text?: string }[])[0]?.text),
      /validation/i,
    );
    assert.equal(
      received.strict_echo?.length,
      1,
      "the rejected call must never reach the customer handler",
    );

    // ── schema-less tool: decoration adds an args slot for telemetry, the
    // original (ctx)-arity callback still receives the ctx, telemetry exports.
    const ping = await client.callTool({
      name: "ping",
      arguments: { telemetry: { user_intent: "ping intent" } },
    });
    assert.equal(ping.isError, undefined);
    assert.equal((ping.content as { text?: string }[])[0]?.text, "pong");
    const pingCtx = received.ping?.[0] as Record<string, unknown> | undefined;
    assert.ok(
      pingCtx !== null && typeof pingCtx === "object" && "mcpReq" in pingCtx,
      "the schema-less callback must receive the ctx, not an args object",
    );
    toolCall = events().filter((e) => e.kind === "tool_call").at(-1);
    assert.equal(toolCall?.metadata.tool_name, "ping");
    assert.equal(toolCall?.metadata.user_intent, "ping intent");

    // ── owned tool: telemetry reaches the customer untouched, never exported.
    await client.callTool({
      name: "owned_tool",
      arguments: { msg: "m", telemetry: { user_intent: "customer secret" } },
    });
    assert.deepEqual(received.owned_tool?.[0], {
      msg: "m",
      telemetry: { user_intent: "customer secret" },
    });
    toolCall = events().filter((e) => e.kind === "tool_call").at(-1);
    assert.equal(toolCall?.metadata.tool_name, "owned_tool");
    assert.equal(
      toolCall?.metadata.user_intent,
      null,
      "owned-mode telemetry must never be exported",
    );
  } finally {
    await client.close();
  }
});

// Reaches into the SDK's internals the same way the adapter does, to check
// what tools/list would advertise without spinning up a client.
const advertisedJson = (server: unknown, name: string): ToolSchema | undefined => {
  return (
    server as { toolInputSchemaJson: (name: string) => ToolSchema | undefined }
  ).toolInputSchemaJson(name);
};

test("declareTelemetry decorates tools registered AFTER instrumentation too", async () => {
  const { events, emit } = collectBatches();
  const server = withMcpAnalytics(
    new McpServer(
      { name: "late-fixture", version: "0.0.1" },
      { capabilities: { tools: {} } },
    ),
    testConfig(emit),
    { declareTelemetry: true },
  );
  let received: unknown;
  server.registerTool(
    "late",
    { inputSchema: asInputSchema(zv4.object({ q: zv4.string() })) },
    async (args: unknown) => {
      received = args;
      return { content: [{ type: "text" as const, text: "late:ok" }] };
    },
  );

  const advertised = advertisedJson(server, "late");
  const telemetry = advertised?.properties?.telemetry as
    | { description?: string }
    | undefined;
  assert.ok(telemetry, "late-registered tool must advertise telemetry");
  assert.equal(telemetry.description, TELEMETRY_PROPERTY_DESCRIPTION);
  assert.deepEqual(advertised?.required, ["q"], "required keys are untouched");

  // The wrapped callback still strips and exports.
  const handler = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
    }
  )._registeredTools.late?.handler;
  assert.ok(handler);
  await handler(
    { q: "x", telemetry: { user_intent: "late intent" } },
    { mcpReq: { id: 1 }, http: { req: new Request("http://in-process.local/mcp") } },
  );
  assert.deepEqual(received, { q: "x" });
  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.equal(toolCall?.metadata.user_intent, "late intent");
});

test("declareTelemetry stays opt-in and yields to captureTelemetry:false", async () => {
  const { emit } = collectBatches();

  // Default: no decoration (existing v2 behavior).
  const undecorated = withMcpAnalytics(
    new McpServer(
      { name: "default-fixture", version: "0.0.1" },
      { capabilities: { tools: {} } },
    ),
    testConfig(emit),
  );
  undecorated.registerTool(
    "plain",
    { description: "Plain.", inputSchema: asInputSchema(zv4.object({ q: zv4.string() })) },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );
  assert.equal(
    advertisedJson(undecorated, "plain")?.properties?.telemetry,
    undefined,
    "without declareTelemetry the schema must stay untouched",
  );

  // Capture off: advertising a field we would drop would be lying to clients.
  const { emit: emitScrub } = collectBatches();
  const scrubbed = withMcpAnalytics(
    new McpServer(
      { name: "scrub-fixture", version: "0.0.1" },
      { capabilities: { tools: {} } },
    ),
    testConfig(emitScrub, { captureTelemetry: false }),
    { declareTelemetry: true },
  );
  scrubbed.registerTool(
    "quiet",
    { description: "Quiet.", inputSchema: asInputSchema(zv4.object({ q: zv4.string() })) },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );
  assert.equal(
    advertisedJson(scrubbed, "quiet")?.properties?.telemetry,
    undefined,
    "captureTelemetry:false must suppress decoration",
  );
});
