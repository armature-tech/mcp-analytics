import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  withMcpAnalytics,
  type AnalyticsIngestBatch,
  type JsonObjectSchema,
} from "../src/index.js";

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

test("withMcpAnalytics instruments server.registerTool calls end-to-end", async () => {
  const { batches, emit } = collectBatches();

  const { result: server, recorder } = withMcpAnalytics(
    {
      armature: { delivery: "await", actorId: "registerTool-actor", emit },
    },
    () => {
      const s = new McpServer({ name: "register-tool-server", version: "0.0.1" });
      s.registerTool(
        "lookup_customer",
        {
          description: "Look up a customer.",
          inputSchema: { customer: z.string().min(1) },
        },
        async (args) => ({
          content: [
            { type: "text" as const, text: `noted: ${args.customer}` },
          ],
        }),
      );
      return s;
    },
  );

  const client = new Client({ name: "rt-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    const listed = await client.listTools();
    const schema = listed.tools[0]?.inputSchema as JsonObjectSchema;
    assert.ok(schema.properties?.telemetry, "telemetry property should be advertised");

    const callResult = await client.callTool({
      name: "lookup_customer",
      arguments: {
        customer: "Folk",
        telemetry: { intent: "registerTool round trip" },
      },
    });
    const content = callResult.content as { text: string }[];
    assert.equal(content[0]?.text, "noted: Folk");

    const toolCall = batches
      .flatMap((b) => b.events)
      .find((e) => e.kind === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall?.metadata.tool_name, "lookup_customer");
    assert.equal(toolCall?.metadata.intent, "registerTool round trip");
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});

test("withMcpAnalytics instruments the deprecated server.tool(...) overload (PRIA case)", async () => {
  const { batches, emit } = collectBatches();

  const { result: server, recorder } = withMcpAnalytics(
    {
      armature: { delivery: "await", actorId: "tool-overload-actor", emit },
    },
    () => {
      const s = new McpServer({ name: "tool-overload-server", version: "0.0.1" });
      // The deprecated `tool(name, description, paramsSchema, cb)` overload is
      // still in heavy use (PRIA, older codebases). Before patching both methods
      // the SDK silently registered these tools without decoration or recording.
      s.tool(
        "lookup_customer",
        "Look up a customer.",
        { customer: z.string().min(1) },
        async (args) => ({
          content: [
            { type: "text" as const, text: `noted: ${args.customer}` },
          ],
        }),
      );
      return s;
    },
  );

  const client = new Client({ name: "tool-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0]?.name, "lookup_customer");
    const schema = listed.tools[0]?.inputSchema as JsonObjectSchema;
    assert.ok(
      schema.properties?.telemetry,
      "deprecated tool() overload should still get its inputSchema decorated",
    );

    const callResult = await client.callTool({
      name: "lookup_customer",
      arguments: {
        customer: "Folk",
        telemetry: { intent: "deprecated overload round trip" },
      },
    });
    const content = callResult.content as { text: string }[];
    assert.equal(content[0]?.text, "noted: Folk");

    const toolCall = batches
      .flatMap((b) => b.events)
      .find((e) => e.kind === "tool_call");
    assert.ok(toolCall, "tool() registered handlers should emit telemetry batches");
    assert.equal(toolCall?.metadata.tool_name, "lookup_customer");
    assert.equal(toolCall?.metadata.intent, "deprecated overload round trip");
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});

test("withMcpAnalytics instruments server.tool(name, cb) — no-schema overload", async () => {
  const { batches, emit } = collectBatches();

  const { result: server, recorder } = withMcpAnalytics(
    {
      armature: { delivery: "await", actorId: "tool-no-schema-actor", emit },
    },
    () => {
      const s = new McpServer({ name: "no-schema-server", version: "0.0.1" });
      s.tool("ping", async () => ({
        content: [{ type: "text" as const, text: "pong" }],
      }));
      return s;
    },
  );

  const client = new Client({ name: "ping-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    const result = await client.callTool({
      name: "ping",
      arguments: { telemetry: { intent: "ping it" } },
    });
    const content = result.content as { text: string }[];
    assert.equal(content[0]?.text, "pong");

    const toolCall = batches
      .flatMap((b) => b.events)
      .find((e) => e.kind === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall?.metadata.tool_name, "ping");
    assert.equal(toolCall?.metadata.intent, "ping it");
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});
