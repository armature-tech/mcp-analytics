import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withMcpAnalytics } from "../../src/index.js";
import {
  createMockAutumnClient,
  createMockAutumnMcpServer,
  type MockAutumnClient,
} from "./mock-autumn-mcp-server.js";

export const createInstrumentedMockAutumnMcpServer = (
  autumn: MockAutumnClient = createMockAutumnClient(),
) => {
  return withMcpAnalytics(
    {
      telemetry: {
        intent: "required",
      },
    },
    () => createMockAutumnMcpServer(autumn),
  );
};

export const main = async () => {
  const { server } = createInstrumentedMockAutumnMcpServer();
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
