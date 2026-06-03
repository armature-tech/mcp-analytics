import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  buildActorId,
  createAnalyticsRecorder,
  decorateInputSchemaWithTelemetry,
  type AnalyticsIngestBatch,
  type JsonObjectSchema,
} from "../src/index.js";

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
      mcpServerId: "recorder-test-server",
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
    mcpServerId: "recorder-test-server",
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
      mcpServerId: "flush-test-server",
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
      mcpServerId: "instrument-success",
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
      mcpServerId: "registry-server",
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
      mcpServerId: "registry-unknown",
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
      mcpServerId: "registry-direct",
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

test("instrumentToolCall records errors, rethrows, and still strips telemetry from the recorded input", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      mcpServerId: "instrument-error",
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
      mcpServerId: "mcp-server-registry",
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
      mcpServerId: "mcp-server-late-attach",
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

test("attaching the same recorder to two McpServers throws", () => {
  const recorder = createAnalyticsRecorder({
    armature: { mcpServerId: "double-attach", actorId: "x" },
  });

  recorder.createMcpServer({ name: "first", version: "0.0.1" });
  assert.throws(
    () => recorder.createMcpServer({ name: "second", version: "0.0.1" }),
    /already attached/,
  );
});
