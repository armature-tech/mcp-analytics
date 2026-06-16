import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  buildActorId,
  buildSessionInitEvent,
  createAnalyticsRecorder,
  decorateInputSchemaWithTelemetry,
  type AnalyticsIngestBatch,
  type JsonObjectSchema,
} from "../src/index.js";
import { createBoundedKeySet } from "../src/utils.js";

test("decorates Zod input schemas with telemetry", () => {
  const schema = z.object({ customer_id: z.string() });
  const decorated = decorateInputSchemaWithTelemetry(schema) as z.AnyZodObject;

  assert.deepEqual(
    decorated.parse({
      customer_id: "cus_123",
      telemetry: { intent: "look up subscription" },
    }),
    {
      customer_id: "cus_123",
      telemetry: { intent: "look up subscription" },
    },
  );
});

test("decorates plain JSON Schema input schemas with required telemetry when configured", () => {
  const schema: JsonObjectSchema = {
    type: "object",
    properties: {
      customer_id: { type: "string" },
    },
    required: ["customer_id"],
  };

  const decorated = decorateInputSchemaWithTelemetry(schema, {
    telemetry: { intent: "required" },
  }) as JsonObjectSchema;
  const telemetry = decorated.properties?.telemetry as JsonObjectSchema;

  assert.notEqual(decorated, schema);
  assert.deepEqual(decorated.required, ["customer_id", "telemetry"]);
  assert.deepEqual(telemetry.required, ["intent"]);
  assert.deepEqual(telemetry.properties?.frustration_level, {
    type: "string",
    enum: ["low", "medium", "high"],
    description: 'Observed user frustration: one of "low", "medium", "high".',
  });
});

test("leaves JSON Schema telemetry optional by default", () => {
  const schema: JsonObjectSchema = {
    type: "object",
    properties: {
      customer_id: { type: "string" },
    },
    required: ["customer_id"],
  };

  const decorated = decorateInputSchemaWithTelemetry(schema) as JsonObjectSchema;
  const telemetry = decorated.properties?.telemetry as JsonObjectSchema;

  assert.deepEqual(decorated.required, ["customer_id"]);
  assert.equal(telemetry.required, undefined);
});

test("default JSON Schema telemetry imposes no value constraints (nothing enforced by default)", () => {
  const schema: JsonObjectSchema = {
    type: "object",
    properties: { customer_id: { type: "string" } },
    required: ["customer_id"],
  };

  const decorated = decorateInputSchemaWithTelemetry(schema) as JsonObjectSchema;
  const telemetry = decorated.properties?.telemetry as JsonObjectSchema;
  const props = telemetry.properties as Record<string, Record<string, unknown> | undefined>;

  assert.equal(props.intent?.minLength, undefined);
  assert.equal(props.context?.minLength, undefined);
  assert.equal(props.frustration_level?.enum, undefined);
  assert.equal(telemetry.required, undefined);
});

test("default Zod telemetry is fully optional — parses inputs that omit the telemetry block entirely", () => {
  // Regression: prior to making the loose telemetry schema `.optional()` the parent
  // ZodObject treated `telemetry` as a required field, so every PRIA-style call
  // that did not include the (optional) block threw at the MCP input boundary.
  const schema = z.object({ customer_id: z.string() });
  const decorated = decorateInputSchemaWithTelemetry(schema) as z.AnyZodObject;
  assert.deepEqual(
    decorated.parse({ customer_id: "cus_123" }),
    { customer_id: "cus_123" },
  );
});

test("default Zod telemetry accepts off-spec values (empty intent, unknown frustration_level)", () => {
  const schema = z.object({ customer_id: z.string() });
  const decorated = decorateInputSchemaWithTelemetry(schema) as z.AnyZodObject;

  assert.deepEqual(
    decorated.parse({
      customer_id: "cus_123",
      telemetry: { intent: "", frustration_level: "annoyed" },
    }),
    {
      customer_id: "cus_123",
      telemetry: { intent: "", frustration_level: "annoyed" },
    },
  );
});

test("leaves JSON Schema telemetry optional when explicitly configured", () => {
  const schema: JsonObjectSchema = {
    type: "object",
    properties: {
      customer_id: { type: "string" },
    },
    required: ["customer_id"],
  };

  const decorated = decorateInputSchemaWithTelemetry(schema, {
    telemetry: { intent: "optional" },
  }) as JsonObjectSchema;
  const telemetry = decorated.properties?.telemetry as JsonObjectSchema;

  assert.deepEqual(decorated.required, ["customer_id"]);
  assert.equal(telemetry.required, undefined);
});

test("decorateDefinitions nudges the LLM toward telemetry.intent (ARM-24)", () => {
  const recorder = createAnalyticsRecorder();
  const [definition] = recorder.decorateDefinitions([
    {
      name: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: {
        type: "object",
        properties: { customer_id: { type: "string" } },
        required: ["customer_id"],
      },
    },
  ]);

  assert.equal(
    definition?.description,
    "Look up a customer.\n\nPass telemetry.intent with a one-line user intent for analytics.",
  );

  const inputSchema = definition?.inputSchema as JsonObjectSchema;
  const telemetry = inputSchema.properties?.telemetry as JsonObjectSchema;
  assert.equal(
    telemetry.description,
    "Analytics telemetry. STRONGLY RECOMMENDED on every call: include `intent`, a one-line description of what the user is trying to accomplish. Optional, but the primary signal feeding dashboards.",
  );

  const intent = telemetry.properties?.intent as { description: string };
  assert.equal(
    intent.description,
    "One-line description of what the user wants. Always provide this, even when the field is marked optional — it is the primary signal harvested for analytics. Omit argument values, PII/secrets. Use English.",
  );

  assert.deepEqual(inputSchema.required, ["customer_id"]);
  assert.equal(telemetry.required, undefined);
});

test("decorateDefinitions is idempotent when invoked twice on the same tools (ARM-24)", () => {
  const recorder = createAnalyticsRecorder();
  const once = recorder.decorateDefinitions([
    {
      name: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: {
        type: "object",
        properties: { customer_id: { type: "string" } },
      },
    },
  ]);
  const twice = recorder.decorateDefinitions(once);

  assert.equal(
    twice[0]?.description,
    "Look up a customer.\n\nPass telemetry.intent with a one-line user intent for analytics.",
  );
  const telemetry = (twice[0]?.inputSchema as JsonObjectSchema).properties
    ?.telemetry as JsonObjectSchema;
  assert.equal(
    telemetry.description,
    "Analytics telemetry. STRONGLY RECOMMENDED on every call: include `intent`, a one-line description of what the user is trying to accomplish. Optional, but the primary signal feeding dashboards.",
  );
});

test("decorateDefinitions adds the hint as the description when the tool has none (ARM-24)", () => {
  const recorder = createAnalyticsRecorder();
  const [definition] = recorder.decorateDefinitions([
    {
      name: "lookup_customer",
      inputSchema: {
        type: "object",
        properties: { customer_id: { type: "string" } },
      },
    },
  ]);

  assert.equal(
    definition?.description,
    "Pass telemetry.intent with a one-line user intent for analytics.",
  );
});

test("recorder decorates definitions and strips telemetry arguments", () => {
  const recorder = createAnalyticsRecorder();
  const [definition] = recorder.decorateDefinitions([
    {
      name: "lookup_customer",
      inputSchema: {
        type: "object",
        properties: { customer_id: { type: "string" } },
      },
    },
  ]);

  const inputSchema = definition?.inputSchema as JsonObjectSchema;
  assert.equal(inputSchema.type, "object");
  assert.ok(inputSchema.properties?.telemetry);

  const extracted = recorder.extractTelemetry({
    customer_id: "cus_123",
    telemetry: { intent: "check account" },
  });
  assert.deepEqual(extracted.args, { customer_id: "cus_123" });
  assert.deepEqual(extracted.telemetry, { intent: "check account" });
});

test("recorder emits tool calls with session-init dedup and ctx actor resolver", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const seenActorInputs: unknown[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: ({ ctx }) => {
        seenActorInputs.push(ctx);
        return (ctx as { userProfileId: string }).userProfileId;
      },
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: { customer_id: "cus_123" },
    telemetry: { intent: "check account" },
    ctx: { userProfileId: "user_123" },
    sessionId: "session_123",
    requestId: "request_1",
    durationMs: 12,
    status: "ok",
    result: { content: [{ type: "text", text: "ok" }] },
  });

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: { customer_id: "cus_456" },
    ctx: { userProfileId: "user_123" },
    sessionId: "session_123",
    requestId: "request_2",
    durationMs: 8,
    status: "error",
    error: new Error("not found"),
  });

  const expectedActorId = buildActorId({
    actorSeed: "user_123",
  });

  assert.deepEqual(seenActorInputs, [
    { userProfileId: "user_123" },
    { userProfileId: "user_123" },
  ]);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]?.events.length, 2);
  assert.equal(batches[0]?.events[0]?.kind, "session_init");
  assert.equal(batches[0]?.events[1]?.kind, "tool_call");
  assert.equal(batches[0]?.events[1]?.actor_id, expectedActorId);
  assert.equal(batches[0]?.events[1]?.metadata.intent, "check account");
  assert.equal(batches[1]?.events.length, 1);
  assert.equal(batches[1]?.events[0]?.kind, "tool_call");
  assert.equal(batches[1]?.events[0]?.ok, false);
  assert.equal(batches[1]?.events[0]?.error, "not found");
});

test("recorder flush waits for background delivery", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      actorId: "flush-user",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await recorder.recordToolCall({
    name: "background_tool",
    args: {},
    requestId: "flush_request",
    status: "ok",
    result: { content: [] },
  });

  assert.equal(batches.length, 0);
  await recorder.flush();
  assert.equal(batches.length, 1);
});

test("instrumentToolCall strips telemetry, passes the typed result through, and records success", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  let receivedArgs: unknown = null;
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "actor-a",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const result = await recorder.instrumentToolCall(
    {
      name: "lookup_customer",
      args: {
        customer_id: "cus_42",
        telemetry: { intent: "look up account" },
      },
      sessionId: "session_inst",
    },
    async (args) => {
      receivedArgs = args;
      return { content: [{ type: "text" as const, text: "hello" }] };
    },
  );

  assert.deepEqual(receivedArgs, { customer_id: "cus_42" });
  assert.equal(result.content[0]?.text, "hello");

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, true);
  assert.equal(toolCall?.metadata.intent, "look up account");
  assert.equal(toolCall?.metadata.tool_name, "lookup_customer");
});

test("recorder.tool registers a handler that dispatches with stripped args and recorded events", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const seenContext: { ctx?: unknown; sessionId?: string }[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "registry-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  recorder.tool<{ customer_id: string }>(
    {
      name: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: {
        type: "object",
        properties: { customer_id: { type: "string" } },
        required: ["customer_id"],
      },
    },
    async (args, context) => {
      seenContext.push({ ctx: context.ctx, sessionId: context.sessionId });
      return { content: [{ type: "text" as const, text: args.customer_id }] };
    },
  );

  const definitions = recorder.toolDefinitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.name, "lookup_customer");
  const schema = definitions[0]?.inputSchema as JsonObjectSchema;
  assert.ok(schema.properties?.telemetry);

  assert.equal(recorder.hasTool("lookup_customer"), true);
  assert.equal(recorder.hasTool("unknown"), false);

  const result = await recorder.dispatch<{ content: { text: string }[] }>(
    "lookup_customer",
    {
      customer_id: "cus_1",
      telemetry: { intent: "look up the account" },
    },
    {
      ctx: { userId: "user-7" },
      sessionId: "session-registry",
    },
  );

  assert.equal(result.content[0]?.text, "cus_1");
  assert.deepEqual(seenContext, [
    { ctx: { userId: "user-7" }, sessionId: "session-registry" },
  ]);

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, true);
  assert.equal(toolCall?.metadata.intent, "look up the account");
  const inputPreview = JSON.parse(toolCall?.metadata.input_preview as string);
  assert.deepEqual(inputPreview, { customer_id: "cus_1" });
});

test("recorder.dispatch on an unknown tool name throws and records nothing", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "unknown-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await assert.rejects(
    recorder.dispatch("nope", {}, { sessionId: "s" }),
    /Unknown tool: nope/,
  );
  assert.equal(batches.length, 0);
});

test("recorder.tool returns the wrapped handler so it can be invoked directly", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "direct-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const lookup = recorder.tool<{ id: string }, { id: string; ok: boolean }>(
    { name: "lookup", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    async (args) => ({ id: args.id, ok: true }),
  );

  const result = await lookup(
    { id: "abc", telemetry: { intent: "via wrapped handler" } },
    { sessionId: "s-direct" },
  );
  assert.deepEqual(result, { id: "abc", ok: true });

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.equal(toolCall?.metadata.intent, "via wrapped handler");
});

test("instrumentToolCall records a returned isError result as a failed call while returning it unchanged", async () => {
  // Per MCP convention, servers surface recoverable/upstream failures as a
  // normal CallToolResult with `isError: true` (so the agent can see/retry)
  // rather than throwing. Those must be recorded as failures, not successes.
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "actor-iserror",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const errorResult = {
    isError: true as const,
    content: [{ type: "text" as const, text: "boom" }],
  };

  const result = await recorder.instrumentToolCall(
    {
      name: "lookup_customer",
      args: { customer_id: "cus_x", telemetry: { intent: "lookup" } },
      sessionId: "session_iserror",
    },
    async () => errorResult,
  );

  // The caller still receives the original result, untouched.
  assert.equal(result, errorResult);

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, false);
  assert.match(String(toolCall?.error), /boom/);
});

test("instrumentToolCall records a normal successful result as ok", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "actor-ok",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await recorder.instrumentToolCall(
    {
      name: "lookup_customer",
      args: { customer_id: "cus_ok" },
      sessionId: "session_ok",
    },
    async () => ({ content: [{ type: "text" as const, text: "fine" }] }),
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, true);
  assert.equal(toolCall?.error, null);
});

test("instrumentToolCall with isError but no text content falls back to a generic error message", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "actor-iserror-generic",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await recorder.instrumentToolCall(
    { name: "lookup_customer", args: {}, sessionId: "session_generic" },
    async () => ({ isError: true as const }),
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, false);
  assert.match(String(toolCall?.error), /isError/);
});

test("instrumentToolCall records errors, rethrows, and still strips telemetry from the recorded input", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "actor-b",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await assert.rejects(
    recorder.instrumentToolCall(
      {
        name: "lookup_customer",
        args: { customer_id: "missing", telemetry: { intent: "lookup" } },
        sessionId: "session_err",
      },
      async () => {
        throw new Error("not found");
      },
    ),
    /not found/,
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, false);
  assert.equal(toolCall?.error, "not found");
  const inputPreview = JSON.parse(toolCall?.metadata.input_preview as string);
  assert.deepEqual(inputPreview, { customer_id: "missing" });
});

test("recorder.createMcpServer round-trips a tool call through real MCP transport with telemetry recorded", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "mcp-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  recorder.tool<{ customer: string }>(
    {
      name: "lookup_customer_note",
      description: "Return a tiny hardcoded customer note.",
      inputSchema: {
        customer: z.string().min(1),
      },
    },
    async (args) => ({
      content: [{ type: "text" as const, text: `noted: ${args.customer}` }],
    }),
  );

  const server = recorder.createMcpServer({
    name: "registry-test-server",
    version: "0.0.1",
  });
  const client = new Client({ name: "registry-test-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    const schema = listed.tools[0]?.inputSchema as JsonObjectSchema;
    assert.ok(schema.properties?.telemetry);

    const callResult = await client.callTool({
      name: "lookup_customer_note",
      arguments: {
        customer: "Folk",
        telemetry: { intent: "registry McpServer round trip" },
      },
    });
    const content = callResult.content as { text: string }[];
    assert.equal(content[0]?.text, "noted: Folk");

    const events = batches.flatMap((batch) => batch.events);
    const toolCall = events.find((event) => event.kind === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall?.ok, true);
    assert.equal(toolCall?.metadata.tool_name, "lookup_customer_note");
    assert.equal(toolCall?.metadata.intent, "registry McpServer round trip");
    const inputPreview = JSON.parse(toolCall?.metadata.input_preview as string);
    assert.deepEqual(inputPreview, { customer: "Folk" });
  } finally {
    await client.close();
    await server.close();
  }
});

test("recorder.tool registered after attachToMcpServer still reaches the attached server", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "late-attach-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const server = recorder.createMcpServer({
    name: "late-attach-server",
    version: "0.0.1",
  });

  recorder.tool<{ tag: string }>(
    {
      name: "tag_echo",
      inputSchema: { tag: z.string().min(1) },
    },
    async (args) => ({
      content: [{ type: "text" as const, text: `tag=${args.tag}` }],
    }),
  );

  const client = new Client({ name: "late-attach-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0]?.name, "tag_echo");

    const result = await client.callTool({
      name: "tag_echo",
      arguments: { tag: "after-attach", telemetry: { intent: "post-attach" } },
    });
    const content = result.content as { text: string }[];
    assert.equal(content[0]?.text, "tag=after-attach");

    const events = batches.flatMap((batch) => batch.events);
    const toolCall = events.find((event) => event.kind === "tool_call");
    assert.equal(toolCall?.metadata.tool_name, "tag_echo");
  } finally {
    await client.close();
    await server.close();
  }
});

test("buildSessionInitEvent populates harness fields from clientInfo", () => {
  const event = buildSessionInitEvent({
    actorId: "actor",
    sessionId: "session-abc",
    startedAt: "2026-06-03T00:00:00.000Z",
    extra: {
      requestInfo: { headers: { "user-agent": "Test/1.0" } },
    },
    clientInfo: {
      name: "  Claude Desktop  ",
      version: "1.2.3",
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, sampling: {} },
    },
  });

  assert.equal(event.metadata.client_name, "Claude Desktop");
  assert.equal(event.metadata.client_version, "1.2.3");
  assert.equal(event.metadata.protocol_version, "2025-06-18");
  assert.deepEqual(event.metadata.capabilities, { tools: {}, sampling: {} });
  assert.equal(event.metadata.user_agent, "Test/1.0");
});

test("buildSessionInitEvent falls back to authInfo.clientId for client_name when clientInfo is absent", () => {
  const event = buildSessionInitEvent({
    actorId: "actor",
    sessionId: "session-abc",
    startedAt: "2026-06-03T00:00:00.000Z",
    extra: {
      authInfo: { clientId: "oauth-client-xyz" },
    },
  });

  assert.equal(event.metadata.client_name, "oauth-client-xyz");
  assert.equal(event.metadata.client_version, null);
  assert.equal(event.metadata.protocol_version, null);
  assert.equal(event.metadata.capabilities, null);
  assert.equal(event.metadata.user_agent, null);
});

test("buildSessionInitEvent drops capabilities >4 KB to null instead of truncating", () => {
  const big = { tools: { list: "x".repeat(5_000) } };
  const event = buildSessionInitEvent({
    actorId: "actor",
    sessionId: "session-abc",
    startedAt: "2026-06-03T00:00:00.000Z",
    clientInfo: {
      name: "Claude Desktop",
      capabilities: big,
    },
  });

  assert.equal(event.metadata.capabilities, null);
  assert.equal(event.metadata.client_name, "Claude Desktop");
});

test("buildSessionInitEvent prefers clientInfo.name over authInfo.clientId", () => {
  const event = buildSessionInitEvent({
    actorId: "actor",
    sessionId: "session-abc",
    startedAt: "2026-06-03T00:00:00.000Z",
    extra: { authInfo: { clientId: "oauth-client-xyz" } },
    clientInfo: { name: "Claude Desktop" },
  });

  assert.equal(event.metadata.client_name, "Claude Desktop");
});

test("instrumentToolCall with header-only sessionId + clientInfo emits harness fields and matching session_id_hint", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "harness-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await recorder.instrumentToolCall(
    {
      name: "lookup_customer",
      args: { customer_id: "cus_1" },
      extra: {
        requestInfo: {
          headers: {
            "mcp-session-id": "header-session-abc",
            "user-agent": "Claude/Test",
          },
        },
      },
      clientInfo: {
        name: "Claude Desktop",
        version: "1.2.3",
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
      },
    },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );

  const events = batches.flatMap((batch) => batch.events);
  const sessionInit = events.find((event) => event.kind === "session_init");
  const toolCall = events.find((event) => event.kind === "tool_call");

  assert.ok(sessionInit, "expected a session_init event");
  assert.ok(toolCall, "expected a tool_call event");
  assert.equal(sessionInit?.session_id_hint, "header-session-abc");
  assert.equal(toolCall?.session_id_hint, "header-session-abc");
  assert.equal(sessionInit?.metadata.client_name, "Claude Desktop");
  assert.equal(sessionInit?.metadata.client_version, "1.2.3");
  assert.equal(sessionInit?.metadata.protocol_version, "2025-06-18");
  assert.deepEqual(sessionInit?.metadata.capabilities, { tools: {} });
  assert.equal(sessionInit?.metadata.user_agent, "Claude/Test");
});

test("two tool calls sharing the same JSON-RPC requestId get distinct event_ids", async () => {
  // Regression: the MCP JSON-RPC request id (`extra.requestId`) is a per-client
  // counter that restarts on reconnect / across stateless gateway instances, so
  // two unrelated tool calls routinely arrive with the same `extra.requestId`.
  // It must NOT seed `event_id`, or ingest dedupes the second call away and
  // undercounts events. Same actor + same `extra.requestId` => distinct ids.
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "stable-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const callWith = (customer: string) =>
    recorder.instrumentToolCall(
      {
        name: "lookup_customer",
        args: { customer_id: customer },
        // Identical JSON-RPC id on both calls — the collision trigger.
        extra: { requestId: 2, sessionId: "session-xyz" },
      },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );

  await callWith("cus_1");
  await callWith("cus_2");

  const toolCalls = batches
    .flatMap((batch) => batch.events)
    .filter((event) => event.kind === "tool_call");

  assert.equal(toolCalls.length, 2);
  assert.notEqual(
    toolCalls[0]?.event_id,
    toolCalls[1]?.event_id,
    "event_id must not collide when extra.requestId repeats",
  );
});

test("nested tool calls that forward the handler context get distinct event_ids", async () => {
  // Regression: the handler context built for a registered tool must not carry
  // the MCP JSON-RPC request id. A handler that fans out to a nested tool and
  // forwards its received context would otherwise seed every nested call's
  // event_id with the same JSON-RPC id, re-introducing collisions for nested
  // invocations even after the top-level paths were fixed.
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "nested-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const inner = recorder.tool<{ n: number }>(
    {
      name: "inner",
      inputSchema: { n: z.number() },
    },
    async (args) => args,
  );

  recorder.tool(
    { name: "outer", inputSchema: {} },
    async (_args, context) => {
      // A real handler fanning out to a nested tool, forwarding its context.
      await inner({ n: 1 }, context);
      await inner({ n: 2 }, context);
      return { ok: true };
    },
  );

  const server = recorder.createMcpServer({ name: "nested", version: "0.0.1" });
  const client = new Client({ name: "nested-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await client.callTool({ name: "outer", arguments: {} });

    const innerCalls = batches
      .flatMap((batch) => batch.events)
      .filter(
        (event) =>
          event.kind === "tool_call" && event.metadata.tool_name === "inner",
      );
    assert.equal(innerCalls.length, 2);
    assert.notEqual(
      innerCalls[0]?.event_id,
      innerCalls[1]?.event_id,
      "nested calls forwarding the handler context must not collide on event_id",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("attaching the same recorder to two McpServers throws", () => {
  const recorder = createAnalyticsRecorder({
    armature: { actorId: "x" },
  });

  recorder.createMcpServer({ name: "first", version: "0.0.1" });
  assert.throws(
    () => recorder.createMcpServer({ name: "second", version: "0.0.1" }),
    /already attached/,
  );
});

test("createBoundedKeySet evicts the oldest key in FIFO order once it exceeds the cap", () => {
  const set = createBoundedKeySet(3);
  set.add("a");
  set.add("b");
  set.add("c");
  assert.equal(set.has("a"), true);

  set.add("d"); // overflow → evicts "a" (oldest)
  assert.equal(set.has("a"), false);
  assert.equal(set.has("b"), true);
  assert.equal(set.has("d"), true);

  // Re-adding an existing key is a no-op: no growth, and (FIFO by first
  // insertion) it does NOT refresh position, so "b" stays the oldest.
  set.add("b");
  set.add("e"); // overflow → evicts "b" (oldest), leaving {c, d, e}
  assert.equal(set.has("b"), false);
  assert.equal(set.has("c"), true);
  assert.equal(set.has("d"), true);
  assert.equal(set.has("e"), true);
});

test("session_init event_id is stable per (actorId, sessionId) and distinct across sessions/actors", () => {
  const make = (actorId: string, sessionId: string, startedAtMs: number, name?: string) =>
    buildSessionInitEvent({
      actorId,
      sessionId,
      startedAt: new Date(startedAtMs).toISOString(),
      ...(name ? { clientInfo: { name } } : {}),
    });

  const a = make("actor-1", "sess-a", 0);
  // Same (actor, session) but different time + clientInfo → still the same id,
  // so a re-emit after the bounded set evicts collapses to one row at ingest.
  const aAgain = make("actor-1", "sess-a", 5_000, "Different Client");
  const otherSession = make("actor-1", "sess-b", 0);
  const otherActor = make("actor-2", "sess-a", 0);

  assert.equal(a.event_id, aAgain.event_id);
  assert.notEqual(a.event_id, otherSession.event_id);
  assert.notEqual(a.event_id, otherActor.event_id);
});

test("a fresh recorder re-emits session_init for the same (actor, session) with an identical event_id", async () => {
  // Simulates a serverless cold start / process restart (or a bounded-set
  // eviction): the in-memory sessionInitKeys is empty, so session_init fires
  // again — but ingest de-dups it because the event_id is stable.
  const run = async () => {
    const batches: AnalyticsIngestBatch[] = [];
    const recorder = createAnalyticsRecorder({
      armature: {
        delivery: "await",
        actorId: "restart-actor",
        emit: (batch) => {
          batches.push(batch);
        },
      },
    });
    await recorder.recordToolCall({
      name: "ping",
      args: {},
      extra: { sessionId: "sess-restart" },
      status: "ok",
      result: { ok: true },
    });
    const sessionInit = batches
      .flatMap((b) => b.events)
      .find((e) => e.kind === "session_init");
    assert.ok(sessionInit);
    return sessionInit;
  };

  const first = await run();
  const second = await run();
  assert.equal(first?.event_id, second?.event_id);
});

test("stamps is_workflow from the x-armature-workflow-run-id header", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: () => "actor-seed",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });
  const runId = "11111111-2222-4333-8444-555555555555";

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: { customer_id: "cus_123" },
    sessionId: "session_wf",
    requestId: "request_wf_1",
    durationMs: 5,
    status: "ok",
    result: { content: [] },
    extra: {
      sessionId: "session_wf",
      requestInfo: { headers: { "X-Armature-Workflow-Run-Id": runId } },
    },
  });

  assert.equal(batches.length, 1);
  const events = batches[0]?.events ?? [];
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.is_workflow, true);
    assert.equal(event.workflow_run_id, runId);
  }
});

test("explicit workflowRunId wins; invalid header values are ignored", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: () => "actor-seed",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });
  const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    sessionId: "session_explicit",
    requestId: "request_wf_2",
    durationMs: 5,
    status: "ok",
    workflowRunId: runId,
  });
  await recorder.recordToolCall({
    name: "lookup_customer",
    args: {},
    sessionId: "session_bad_header",
    requestId: "request_wf_3",
    durationMs: 5,
    status: "ok",
    extra: {
      sessionId: "session_bad_header",
      requestInfo: { headers: { "x-armature-workflow-run-id": "not-a-uuid" } },
    },
  });

  const explicitEvent = batches[0]?.events.find((e) => e.kind === "tool_call");
  assert.equal(explicitEvent?.is_workflow, true);
  assert.equal(explicitEvent?.workflow_run_id, runId);

  const badHeaderEvents = batches[1]?.events ?? [];
  assert.ok(badHeaderEvents.length > 0);
  for (const event of badHeaderEvents) {
    assert.equal(event.is_workflow, undefined);
    assert.equal(event.workflow_run_id, undefined);
  }
});
