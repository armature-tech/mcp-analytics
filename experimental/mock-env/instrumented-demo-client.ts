import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultMcpAnalyticsConfig } from "../../src/index.js";
import { createInstrumentedMockAutumnMcpServer } from "./instrumented-mock-autumn-mcp-server.js";
import { createMockArmatureServer } from "./mock-armature-server.js";

const delay = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const waitForTelemetry = async (telemetryUrl: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(telemetryUrl);
    const body = (await response.json()) as {
      telemetry?: Array<{ payload?: Record<string, unknown> }>;
    };

    if (body.telemetry?.length) {
      return body.telemetry;
    }

    await delay(25);
  }

  throw new Error("Timed out waiting for telemetry POST.");
};

const armatureServer = createMockArmatureServer();
await new Promise<void>((resolve) => {
  armatureServer.listen(0, "127.0.0.1", resolve);
});
const armatureAddress = armatureServer.address() as AddressInfo;
const armatureTelemetryUrl = `http://127.0.0.1:${armatureAddress.port}/telemetry`;

const { server, autumn } = createInstrumentedMockAutumnMcpServer(undefined, {
  ...defaultMcpAnalyticsConfig,
  armature: {
    ...defaultMcpAnalyticsConfig.armature,
    endpointUrl: `${armatureTelemetryUrl.replace(/\/telemetry$/, "")}/api/mcp-analytics/ingest`,
    ingestSecret: "mock-secret",
    mcpServerId: "mock-autumn-mcp-server",
  },
});
const client = new Client({
  name: "instrumented-mock-autumn-demo-client",
  version: "0.0.0",
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

try {
  const toolList = await client.listTools();
  console.log("INSTRUMENTED TOOLS/LIST");
  console.log(JSON.stringify(toolList, null, 2));

  const toolCall = await client.callTool({
    name: "create_customer",
    arguments: {
      customer_id: "cus_1",
      email: "alice@example.com",
      name: "Alice",
      telemetry: {
        intent: "Create a customer in the mock Autumn system.",
        context: "Exercise the wrapped mock Autumn MCP through the ingest batch format.",
        frustration_level: "low",
      },
    },
  });
  console.log("\nINSTRUMENTED TOOLS/CALL");
  console.log(JSON.stringify(toolCall, null, 2));

  console.log("\nMOCK AUTUMN CALLS");
  console.log(JSON.stringify(autumn.calls, null, 2));

  assert.deepStrictEqual(autumn.calls, [
    {
      customer_id: "cus_1",
      email: "alice@example.com",
      name: "Alice",
    },
  ]);

  const receivedTelemetry = await waitForTelemetry(armatureTelemetryUrl);
  console.log("\nMOCK ARMATURE TELEMETRY");
  console.log(JSON.stringify(receivedTelemetry, null, 2));

  const payload = receivedTelemetry[0]?.payload;
  assert.equal(payload?.schema_version, 1);
  assert.ok(Array.isArray(payload?.events));
  const event = payload?.events?.[0] as Record<string, unknown> | undefined;
  assert.equal(event?.kind, "tool_call");
  assert.equal(event?.mcp_server_id, "mock-autumn-mcp-server");
  assert.equal(event?.ok, true);
  assert.equal((event?.metadata as Record<string, unknown>)?.tool_name, "create_customer");
  assert.equal((event?.metadata as Record<string, unknown>)?.intent, "Create a customer in the mock Autumn system.");
  assert.equal((event?.metadata as Record<string, unknown>)?.context, "Exercise the wrapped mock Autumn MCP through the ingest batch format.");
  assert.equal((event?.metadata as Record<string, unknown>)?.frustration_level, "low");
  assert.match(String((event?.metadata as Record<string, unknown>)?.input_preview), /cus_1/);
  assert.match(String(event?.result_preview), /alice@example.com/);
} finally {
  await client.close();
  await server.close();
  await new Promise<void>((resolve, reject) => {
    armatureServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
