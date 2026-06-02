import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createMcpAnalyticsServer } from "../../src/index.js";

export type DemoCustomerLookupArgs = {
  customer: string;
};

export const createDemoMcpServer = () => {
  const server = new McpServer({
    name: "experimental-vercel-mcp-demo",
    version: "0.1.0",
  });

  server.registerTool(
    "lookup_customer_note",
    {
      title: "Lookup Customer Note",
      description: "Return a tiny hardcoded customer note for deployment smoke tests.",
      inputSchema: {
        customer: z.string().min(1).describe("Customer name or account label."),
      },
    },
    async (args: DemoCustomerLookupArgs): Promise<CallToolResult> => {
      const normalized = args.customer.trim();
      const note = normalized.toLowerCase().includes("folk")
        ? "Folk account note: interested in lightweight MCP analytics demos."
        : `${normalized} account note: no live CRM lookup was performed.`;

      return {
        content: [
          {
            type: "text",
            text: note,
          },
        ],
        structuredContent: {
          customer: normalized,
          note,
          source: "hardcoded-demo",
        },
      };
    },
  );

  return { server };
};

export const createInstrumentedDemoMcpServer = () => {
  return createMcpAnalyticsServer(
    createDemoMcpServer,
    {
      telemetry: {
        intent: "required",
      },
      armature: {
        enabled: true,
        mcpServerId: "experimental-vercel-mcp-demo",
        actorId: "experimental-vercel-demo-actor",
        emit(event) {
          console.log(JSON.stringify({
            type: "experimental_vercel_mcp_telemetry",
            event,
          }));
        },
      },
    },
  );
};
