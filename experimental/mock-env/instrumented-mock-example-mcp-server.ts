import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createMcpAnalyticsServer,
  type McpAnalyticsConfig,
} from "../../src/index.js";
import {
  createMockExampleClient,
  createMockExampleMcpServer,
  type MockExampleClient,
} from "./mock-example-mcp-server.js";

export const createInstrumentedMockExampleMcpServer = (
  exampleMcp: MockExampleClient = createMockExampleClient(),
  config?: McpAnalyticsConfig,
) => {
  return createMcpAnalyticsServer(
    () => createMockExampleMcpServer(exampleMcp),
    config,
  );
};

export const main = async () => {
  const { server } = createInstrumentedMockExampleMcpServer();
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
