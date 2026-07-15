import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";
import { z } from "zod";

if (!process.env.ANALYTICS_INGEST_API_KEY) {
  throw new Error("Set ANALYTICS_INGEST_API_KEY before starting the server.");
}

const server = createMcpAnalyticsServer(
  () => {
    const mcp = new McpServer({
      name: "armature-minimal-typescript",
      version: "0.1.0",
    });

    mcp.registerTool(
      "echo",
      {
        description: "Echoes the supplied text",
        inputSchema: { text: z.string().describe("Text to echo") },
      },
      async ({ text }) => ({
        content: [{ type: "text", text: `echo: ${text}` }],
      }),
    );

    return mcp;
  },
  { armature: { delivery: "await" } },
);

await server.connect(new StdioServerTransport());
