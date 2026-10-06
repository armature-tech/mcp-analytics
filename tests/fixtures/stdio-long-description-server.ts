// Stdio fixture whose only tool has a description longer than
// MAX_TOOL_DESCRIPTION_LENGTH. The SDK no longer adds text to descriptions, so
// it passes the description through unchanged and logs no length notice,
// whatever DESCRIPTION_LENGTH_LOG_LEVEL says (the option is accepted and
// ignored). stdout must carry nothing but JSON-RPC for the client to parse.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpAnalyticsServer, type DescriptionLengthLogLevel } from "../../src/index.js";

const LONG_DESCRIPTION = "z".repeat(2000);

const server = createMcpAnalyticsServer(
  () => {
    const s = new McpServer({ name: "stdio-long-description", version: "0.0.1" });
    s.registerTool("long_tool", { description: LONG_DESCRIPTION }, async () => ({
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
