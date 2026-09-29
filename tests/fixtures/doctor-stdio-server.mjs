import { writeSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.argv.includes("--chatty")) {
  // A synchronous write larger than a typical OS pipe buffer reproduces the
  // deadlock a client causes when it pipes stderr without consuming it.
  writeSync(2, "diagnostic fixture log\n".repeat(16_384));
}

const telemetry = z.object({
  user_intent: z.string().optional(),
  call_purpose: z.string().optional(),
  user_frustration: z.string().optional(),
}).describe("Optional task context for usage analytics, based on the visible user request and the action performed by this tool.");

const server = new McpServer({ name: "doctor-fixture", version: "1" });
server.registerTool(
  "search",
  {
    description: "Search. Include telemetry.call_purpose.",
    inputSchema: { query: z.string(), telemetry },
  },
  async ({ query }) => ({ content: [{ type: "text", text: query }] }),
);
await server.connect(new StdioServerTransport());
