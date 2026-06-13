import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  instrumentMcpServerTools,
  type AnalyticsIngestBatch,
  type InstrumentedTool,
  type JsonObjectSchema,
} from "../src/index.js";
import {
  INTENT_DESCRIPTION,
  TELEMETRY_PROPERTY_DESCRIPTION,
} from "../src/schema.js";

const TELEMETRY_DESCRIPTION_HINT =
  "Pass telemetry.intent with a one-line user intent for analytics.";

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

test("instrumentMcpServerTools registers tools on a caller-owned McpServer end-to-end", async () => {
  const { batches, emit } = collectBatches();

  const baseServer = new McpServer({ name: "instrument-tools-server", version: "0.0.1" });
  const tools: InstrumentedTool[] = [
    {
      name: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: { customer: z.string().min(1) },
      handler: async (args: unknown) =>
        okText(`noted: ${(args as { customer: string }).customer}`),
    },
  ];

  const { server, recorder } = instrumentMcpServerTools({
    server: baseServer,
    tools,
    config: {
      armature: { delivery: "await", actorId: "instrument-actor", emit },
    },
  });

  // Same instance the caller constructed — we never swap it out.
  assert.equal(server, baseServer);

  const client = new Client({ name: "it-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    const listed = await client.listTools();
    const schema = listed.tools[0]?.inputSchema as JsonObjectSchema;
    assert.ok(
      schema.properties?.telemetry,
      "telemetry block should be advertised on the listed tool",
    );

    // Regression (ARM-24): the LLM nudges must reach the wire in the
    // caller-owned McpServer path too, not just `toolDefinitions()` — without
    // them calling agents mostly omit telemetry.intent.
    assert.equal(
      listed.tools[0]?.description,
      `Look up a customer.\n\n${TELEMETRY_DESCRIPTION_HINT}`,
      "tool description should carry the telemetry.intent hint",
    );
    const telemetrySchema = schema.properties?.telemetry as JsonObjectSchema;
    assert.equal(
      telemetrySchema.description,
      TELEMETRY_PROPERTY_DESCRIPTION,
      "telemetry object should carry its description on the wire",
    );
    const intentSchema = telemetrySchema.properties?.intent as JsonObjectSchema;
    assert.equal(
      intentSchema.description,
      INTENT_DESCRIPTION,
      "telemetry.intent should carry its description on the wire",
    );

    const callResult = await client.callTool({
      name: "lookup_customer",
      arguments: {
        customer: "Folk",
        telemetry: { intent: "instrument round trip" },
      },
    });
    const content = callResult.content as { text: string }[];
    assert.equal(content[0]?.text, "noted: Folk");

    const toolCall = batches
      .flatMap((b) => b.events)
      .find((e) => e.kind === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall?.metadata.tool_name, "lookup_customer");
    assert.equal(toolCall?.metadata.intent, "instrument round trip");
    // Telemetry was stripped before the handler ran (the input_preview echoes
    // what the handler saw, not what came over the wire).
    const inputPreview = JSON.parse(toolCall?.metadata.input_preview as string);
    assert.deepEqual(inputPreview, { customer: "Folk" });
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});

test("instrumentMcpServerTools applies a mapTool to translate a custom registry shape", async () => {
  const { batches, emit } = collectBatches();

  // App-specific registry shape: handler takes (args, extra) directly.
  type AppTool = {
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    handler: (args: unknown, extra: unknown) => unknown;
  };

  const appRegistry: Record<string, AppTool> = {
    lookup: {
      name: "lookup",
      description: "Lookup by id.",
      inputSchema: { id: z.string() },
      handler: (args, _extra) =>
        okText(`found: ${(args as { id: string }).id}`),
    },
    ping: {
      name: "ping",
      description: "Ping.",
      inputSchema: { msg: z.string() },
      handler: (args) => okText(`pong: ${(args as { msg: string }).msg}`),
    },
  };

  const baseServer = new McpServer({ name: "mapper-server", version: "0.0.1" });
  const { server, recorder } = instrumentMcpServerTools({
    server: baseServer,
    tools: appRegistry,
    config: {
      armature: { delivery: "await", actorId: "mapper-actor", emit },
    },
    mapTool: (def, key) => ({
      name: def.name ?? key ?? "anonymous",
      description: def.description,
      inputSchema: def.inputSchema,
      handler: (args, context) => def.handler(args, context.extra),
    }),
  });

  const client = new Client({ name: "mapper-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 2);
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["lookup", "ping"]);

    const r1 = await client.callTool({
      name: "lookup",
      arguments: { id: "abc", telemetry: { intent: "mapper lookup" } },
    });
    assert.equal((r1.content as { text: string }[])[0]?.text, "found: abc");

    const r2 = await client.callTool({ name: "ping", arguments: { msg: "hi" } });
    assert.equal((r2.content as { text: string }[])[0]?.text, "pong: hi");

    const toolCalls = batches
      .flatMap((b) => b.events)
      .filter((e) => e.kind === "tool_call");
    assert.equal(toolCalls.length, 2);
    const lookupEvent = toolCalls.find((e) => e.metadata.tool_name === "lookup");
    assert.equal(lookupEvent?.metadata.intent, "mapper lookup");
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});

test("instrumentMcpServerTools accepts an array of tools without a mapper", async () => {
  const { batches, emit } = collectBatches();
  const baseServer = new McpServer({ name: "array-server", version: "0.0.1" });

  const { server, recorder } = instrumentMcpServerTools({
    server: baseServer,
    tools: [
      {
        name: "a",
        inputSchema: { x: z.string() },
        handler: async (args: unknown) =>
          okText(`a:${(args as { x: string }).x}`),
      },
      {
        name: "b",
        inputSchema: { y: z.string() },
        handler: async (args: unknown) =>
          okText(`b:${(args as { y: string }).y}`),
      },
    ] as InstrumentedTool[],
    config: { armature: { delivery: "await", actorId: "array-actor", emit } },
  });

  const client = new Client({ name: "array-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    // Tools registered without a description still get the telemetry hint as
    // their full description.
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      assert.equal(tool.description, TELEMETRY_DESCRIPTION_HINT);
    }

    await client.callTool({ name: "a", arguments: { x: "1" } });
    await client.callTool({ name: "b", arguments: { y: "2" } });

    const toolCalls = batches
      .flatMap((b) => b.events)
      .filter((e) => e.kind === "tool_call");
    const names = toolCalls.map((e) => e.metadata.tool_name).sort();
    assert.deepEqual(names, ["a", "b"]);
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});

// Compile-time fixture. The two-overload surface should make `mapTool`
// REQUIRED whenever the registry shape doesn't structurally match
// `InstrumentedTool`. If a future refactor collapses to a single optional
// `mapTool` overload, the `@ts-expect-error` below stops matching an actual
// error and `tsc --noEmit -p tsconfig.test.json` (run via `npm run check`)
// fails — catching the regression Greptile flagged on PR #34, where a custom
// registry compiled cleanly without a mapper and threw at runtime when
// `mapped.handler` was undefined.
//
// Body is never invoked — declaring it as a never-called function is enough
// for tsc to typecheck the calls without registering tools at runtime.
const _typeFixture_customRegistryRequiresMapTool = (
  baseServer: McpServer,
) => {
  type CustomTool = { name: string; execute: (a: unknown) => unknown };
  const custom: CustomTool[] = [{ name: "x", execute: () => "noop" }];

  // @ts-expect-error mapTool is required when TDef is not assignable to InstrumentedTool
  instrumentMcpServerTools({
    server: baseServer,
    tools: custom,
    config: { armature: { enabled: false } },
  });

  // Same call typechecks with `mapTool` supplied.
  instrumentMcpServerTools({
    server: baseServer,
    tools: custom,
    config: { armature: { enabled: false } },
    mapTool: (def) => ({
      name: def.name,
      handler: async (args) => okText(String(def.execute(args))),
    }),
  });
};
void _typeFixture_customRegistryRequiresMapTool;

test("instrumentMcpServerTools passes MCP context/extra through to the handler", async () => {
  const { batches, emit } = collectBatches();
  const baseServer = new McpServer({ name: "ctx-server", version: "0.0.1" });

  let seenExtra: unknown = null;
  const { server, recorder } = instrumentMcpServerTools({
    server: baseServer,
    tools: [
      {
        name: "ctx",
        inputSchema: { msg: z.string() },
        handler: async (_args: unknown, context: unknown) => {
          seenExtra = (context as { extra?: unknown }).extra;
          return okText("ok");
        },
      },
    ] as InstrumentedTool[],
    config: { armature: { delivery: "await", actorId: "ctx-actor", emit } },
  });

  const client = new Client({ name: "ctx-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    await client.callTool({ name: "ctx", arguments: { msg: "hi" } });
    // Real transport populated `extra` (sessionId / requestInfo / etc.) — we
    // don't pin every field, but the handler must receive a non-null object.
    assert.ok(seenExtra && typeof seenExtra === "object");
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});
