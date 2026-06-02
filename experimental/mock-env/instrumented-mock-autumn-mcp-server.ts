import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpAnalyticsServer } from "../../src/index.js";
import {
  createMockAutumnClient,
  createMockAutumnMcpServer,
  type MockAutumnClient,
} from "./mock-autumn-mcp-server.js";

export const createInstrumentedMockAutumnMcpServer = (
  autumn: MockAutumnClient = createMockAutumnClient(),
) => {
  return createMcpAnalyticsServer(() => createMockAutumnMcpServer(autumn));
};

export const main = async () => {
  const { server } = createInstrumentedMockAutumnMcpServer();
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
