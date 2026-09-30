// Stdio fixture whose only tool has a description too long for the full
// telemetry hint, so the SDK logs its one-time length notice at startup, at
// the level given in DESCRIPTION_LENGTH_LOG_LEVEL. stdout must carry nothing
// but JSON-RPC for the client to parse.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpAnalyticsServer, type DescriptionLengthLogLevel } from "../../src/index.js";

const server = createMcpAnalyticsServer(
  () => {
    const s = new McpServer({ name: "stdio-long-description", version: "0.0.1" });
    s.registerTool("long_tool", { description: "z".repeat(1000) }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    return s;
  },
  {
    armature: {
      emit: () => undefined,
      descriptionLengthLogLevel: process.env.DESCRIPTION_LENGTH_LOG_LEVEL as DescriptionLengthLogLevel,
    },
  },
);

await server.connect(new StdioServerTransport());
