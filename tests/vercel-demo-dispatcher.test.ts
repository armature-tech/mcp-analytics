import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildActorId,
  type AnalyticsIngestBatch,
  type JsonObjectSchema,
} from "../src/index.js";
import {
  createDispatcherDemo,
  type DispatcherRequestContext,
} from "../experimental/vercel-demo/dispatcher-mcp-server.js";

const buildHarness = () => {
  const batches: AnalyticsIngestBatch[] = [];
  const demo = createDispatcherDemo({
    config: {
      armature: {
        mcpServerId: "vercel-demo-dispatcher",
        emit: (batch) => {
          batches.push(batch);
        },
      },
    },
  });
  return { demo, batches };
};

const buildCtx = (
  overrides: Partial<DispatcherRequestContext> = {},
): DispatcherRequestContext => ({
  sessionId: "session-vercel-1",
  organizationId: "demo-org",
  userProfileId: "user-42",
  ...overrides,
});

test("vercel dispatcher demo decorates the tool with telemetry", () => {
  const { demo } = buildHarness();
  const tools = demo.listTools();
  assert.equal(tools.length, 1);

  const schema = tools[0]?.inputSchema as JsonObjectSchema;
  assert.equal(schema.type, "object");
  assert.ok(schema.properties?.customer);
  assert.ok(schema.properties?.telemetry);
  // Default config => telemetry intent is optional, so neither `telemetry`
  // nor `intent` should appear in any `required` list.
  assert.deepEqual(schema.required, ["customer"]);

  const telemetrySchema = schema.properties?.telemetry as JsonObjectSchema;
  assert.equal(telemetrySchema.required, undefined);
});

test("vercel dispatcher demo records a session_init + tool_call batch with ctx-derived actor", async () => {
  const { demo, batches } = buildHarness();
  const ctx = buildCtx();

  const result = await demo.callTool(
    "lookup_customer_note",
    {
      customer: "Folk",
      telemetry: { intent: "lookup customer note from dispatcher demo" },
    },
    ctx,
  );

  assert.equal(batches.length, 1);
  const events = batches[0]!.events;
  assert.equal(events.length, 2);

  assert.equal(events[0]?.kind, "session_init");
  assert.equal(events[0]?.session_id_hint, "session-vercel-1");

  const toolCall = events[1]!;
  assert.equal(toolCall.kind, "tool_call");
  assert.equal(toolCall.ok, true);
  assert.equal(toolCall.metadata.tool_name, "lookup_customer_note");
  assert.equal(
    toolCall.metadata.intent,
    "lookup customer note from dispatcher demo",
  );
  assert.equal(
    toolCall.actor_id,
    buildActorId({
      mcpServerId: "vercel-demo-dispatcher",
      actorSeed: "user-42",
    }),
  );

  const inputPreview = JSON.parse(toolCall.metadata.input_preview as string);
  assert.deepEqual(inputPreview, { customer: "Folk" });

  const text = (result as { content: { text: string }[] }).content[0]?.text;
  assert.equal(
    text,
    "Folk account note: interested in lightweight MCP analytics demos.",
  );
});

test("vercel dispatcher demo emits a single session_init per session across multiple tool calls", async () => {
  const { demo, batches } = buildHarness();
  const ctx = buildCtx();

  await demo.callTool(
    "lookup_customer_note",
    { customer: "alpha", telemetry: { intent: "first" } },
    ctx,
  );
  await demo.callTool(
    "lookup_customer_note",
    { customer: "beta", telemetry: { intent: "second" } },
    ctx,
  );

  const allEvents = batches.flatMap((batch) => batch.events);
  const sessionInits = allEvents.filter((event) => event.kind === "session_init");
  const toolCalls = allEvents.filter((event) => event.kind === "tool_call");

  assert.equal(sessionInits.length, 1);
  assert.equal(toolCalls.length, 2);
});

test("vercel dispatcher demo recordSessionInit fires session_init before any tool call", async () => {
  const { demo, batches } = buildHarness();
  const ctx = buildCtx();

  await demo.recordSessionInit(ctx);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.events.length, 1);
  assert.equal(batches[0]?.events[0]?.kind, "session_init");

  await demo.callTool(
    "lookup_customer_note",
    { customer: "gamma", telemetry: { intent: "later" } },
    ctx,
  );

  const allEvents = batches.flatMap((batch) => batch.events);
  const sessionInits = allEvents.filter((event) => event.kind === "session_init");
  assert.equal(sessionInits.length, 1);
});

test("vercel dispatcher demo records tool_call errors with the supplied error message", async () => {
  const { demo, batches } = buildHarness();
  const ctx = buildCtx();

  await assert.rejects(
    demo.callTool(
      "lookup_customer_note",
      { customer: "", telemetry: { intent: "blank" } },
      ctx,
    ),
    /customer/,
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, false);
  assert.match(toolCall?.error ?? "", /customer/);
});

test("dedup state does not leak across dispatcher demo instances", async () => {
  const { demo: demoA, batches: batchesA } = buildHarness();
  const { demo: demoB, batches: batchesB } = buildHarness();
  const ctx = buildCtx();

  await demoA.callTool(
    "lookup_customer_note",
    { customer: "alpha", telemetry: { intent: "a" } },
    ctx,
  );
  await demoB.callTool(
    "lookup_customer_note",
    { customer: "beta", telemetry: { intent: "b" } },
    ctx,
  );

  const sessionInitsA = batchesA
    .flatMap((batch) => batch.events)
    .filter((event) => event.kind === "session_init");
  const sessionInitsB = batchesB
    .flatMap((batch) => batch.events)
    .filter((event) => event.kind === "session_init");

  assert.equal(sessionInitsA.length, 1);
  assert.equal(sessionInitsB.length, 1);
});
