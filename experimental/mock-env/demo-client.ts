import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMockAutumnMcpServer } from "./mock-autumn-mcp-server.js";

const { server, autumn } = createMockAutumnMcpServer();
const client = new Client({ name: "mock-autumn-demo-client", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

try {
  const toolList = await client.listTools();
  console.log("TOOLS/LIST");
  console.log(JSON.stringify(toolList, null, 2));

  const toolCall = await client.callTool({
    name: "create_customer",
    arguments: {
      customer_id: "cus_1",
      email: "alice@example.com",
      name: "Alice",
    },
  });
  console.log("\nTOOLS/CALL");
  console.log(JSON.stringify(toolCall, null, 2));

  console.log("\nMOCK AUTUMN CALLS");
  console.log(JSON.stringify(autumn.calls, null, 2));
} finally {
  await client.close();
  await server.close();
}
