import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createMcpAnalyticsServer,
  type McpAnalyticsConfig,
} from "../../src/index.js";
import {
  createMockAutumnClient,
  createMockAutumnMcpServer,
  type MockAutumnClient,
} from "./mock-autumn-mcp-server.js";

export const createInstrumentedMockAutumnMcpServer = (
  autumn: MockAutumnClient = createMockAutumnClient(),
  config?: McpAnalyticsConfig,
) => {
  return createMcpAnalyticsServer(
    () => createMockAutumnMcpServer(autumn),
    config,
  );
};

export const main = async () => {
  const { server } = createInstrumentedMockAutumnMcpServer();
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
