import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createAnalyticsRecorder,
  withMcpAnalytics,
  type AnalyticsIngestBatch,
  type JsonObjectSchema,
} from "../src/index.js";
import { wrapMastraTools, wrapMastraToolsWithRecorder } from "../src/mastra.js";
import {
  REQUEST_CAPABILITY_DESCRIPTION,
  REQUEST_CAPABILITY_TOOL_NAME,
} from "../src/request-capability.js";

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

test("request_capability is disabled by default and when analytics is disabled", () => {
  assert.equal(createAnalyticsRecorder().hasTool(REQUEST_CAPABILITY_TOOL_NAME), false);
  assert.equal(
    createAnalyticsRecorder({
      armature: { enabled: false, requestCapability: true },
    }).hasTool(REQUEST_CAPABILITY_TOOL_NAME),
    false,
  );
});

test("recorder injects and records request_capability when enabled", async () => {
  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: {
      requestCapability: true,
      delivery: "await",
      actorId: "capability-recorder",
      emit,
    },
  });

  const definitions = recorder.toolDefinitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.name, REQUEST_CAPABILITY_TOOL_NAME);
  assert.equal(definitions[0]?.description, REQUEST_CAPABILITY_DESCRIPTION);
  const schema = definitions[0]?.inputSchema as JsonObjectSchema;
  assert.deepEqual(schema.required, ["capability"]);
  assert.equal(schema.properties?.telemetry, undefined);
  assert.equal(
    (schema.properties?.capability as { minLength?: number } | undefined)?.minLength,
    1,
  );
  assert.equal(
    (schema.properties?.capability as { description?: string } | undefined)?.description,
    "The capability required to complete the user's request. Omit argument values, PII, and secrets. Use English.",
  );

  const result = await recorder.dispatch<{ content: { text: string }[] }>(
    REQUEST_CAPABILITY_TOOL_NAME,
    { capability: "Export invoices to CSV" },
    { sessionId: "capability-session" },
  );
  assert.equal(result.content[0]?.text, "Capability request acknowledged.");

  const event = batches.flatMap((batch) => batch.events)
    .find((candidate) => candidate.kind === "tool_call");
  assert.equal(event?.metadata.tool_name, REQUEST_CAPABILITY_TOOL_NAME);
  assert.equal(event?.metadata.capability_request, true);
  assert.deepEqual(JSON.parse(event?.metadata.input_preview as string), {
    capability: "Export invoices to CSV",
  });
});

test("request_capability is reserved when injection is enabled", () => {
  const recorder = createAnalyticsRecorder({
    armature: { requestCapability: true, emit: () => undefined },
  });
  assert.throws(
    () => recorder.tool(
      { name: REQUEST_CAPABILITY_TOOL_NAME },
      async () => ({ content: [] }),
    ),
    /reserved while armature\.requestCapability is enabled/,
  );
});

test("request_capability is suppressed without a configured delivery path", () => {
  const recorder = createAnalyticsRecorder({
    armature: { requestCapability: true, apiKey: "" },
  });
  assert.equal(recorder.hasTool(REQUEST_CAPABILITY_TOOL_NAME), false);
});

test("Mastra low-level wrapper rejects a mismatched recorder configuration", () => {
  const recorder = createAnalyticsRecorder({
    armature: { requestCapability: true, emit: () => undefined },
  });
  assert.throws(
    () => wrapMastraToolsWithRecorder(
      {},
      recorder,
      { armature: { apiKey: "" } },
    ),
    /configuration does not match the supplied analytics recorder/,
  );
});

test("attached McpServer advertises the exact request_capability contract", async () => {
  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: {
      requestCapability: true,
      delivery: "await",
      actorId: "capability-attached",
      emit,
    },
  });
  const server = recorder.createMcpServer({ name: "capability-server", version: "0.0.1" });
  const client = new Client({ name: "capability-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find(({ name }) => name === REQUEST_CAPABILITY_TOOL_NAME);
    assert.ok(tool);
    assert.equal(tool.description, REQUEST_CAPABILITY_DESCRIPTION);
    assert.equal(tool.inputSchema.properties?.telemetry, undefined);

    const result = await client.callTool({
      name: REQUEST_CAPABILITY_TOOL_NAME,
      arguments: { capability: "Send a fax" },
    });
    assert.equal((result.content as { text: string }[])[0]?.text, "Capability request acknowledged.");
    assert.equal(
      batches.flatMap((batch) => batch.events)
        .some((event) => event.metadata.tool_name === REQUEST_CAPABILITY_TOOL_NAME),
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("withMcpAnalytics injects request_capability into factory-created servers", async () => {
  const { batches, emit } = collectBatches();
  const { result: server } = withMcpAnalytics(
    {
      armature: {
        requestCapability: true,
        delivery: "await",
        actorId: "capability-factory",
        emit,
      },
    },
    () => new McpServer({ name: "factory-server", version: "0.0.1" }),
  );
  const client = new Client({ name: "factory-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools[0]?.description, REQUEST_CAPABILITY_DESCRIPTION);
    await client.callTool({
      name: REQUEST_CAPABILITY_TOOL_NAME,
      arguments: { capability: "Generate a PDF" },
    });
    assert.equal(
      batches.flatMap((batch) => batch.events)
        .some((event) => event.metadata.tool_name === REQUEST_CAPABILITY_TOOL_NAME),
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("Mastra adapter injects request_capability when enabled", async () => {
  const { batches, emit } = collectBatches();
  const tools = wrapMastraTools({}, {
    armature: {
      requestCapability: true,
      delivery: "await",
      actorId: "capability-mastra",
      emit,
    },
  }) as Record<string, {
    description?: string;
    execute?: (input: unknown, context?: unknown) => Promise<unknown>;
  }>;

  const tool = tools[REQUEST_CAPABILITY_TOOL_NAME];
  assert.equal(tool?.description, REQUEST_CAPABILITY_DESCRIPTION);
  const result = await tool?.execute?.(
    { capability: "Transcribe a call" },
    { mcp: { extra: { sessionId: "mastra-capability" } } },
  );
  assert.equal(result, "Capability request acknowledged.");
  assert.equal(
    batches.flatMap((batch) => batch.events)
      .some((event) => event.metadata.tool_name === REQUEST_CAPABILITY_TOOL_NAME),
    true,
  );
});
