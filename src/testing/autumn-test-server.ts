import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createAnalyticsMcpServer } from "../server/analytics-mcp-server.js";

export type MockAutumnClient = {
  customers: {
    create(args: {
      customer_id: string;
      email?: string;
      name?: string;
    }): Promise<{ id: string; email?: string; name?: string }>;
  };
};

export const createMockAutumnClient = (): MockAutumnClient => ({
  customers: {
    async create(args) {
      return {
        id: args.customer_id,
        email: args.email,
        name: args.name,
      };
    },
  },
});

export const createAutumnTestServer = (
  autumn: MockAutumnClient = createMockAutumnClient(),
) => {
  const server = createAnalyticsMcpServer({
    name: "autumn-test",
    version: "0.0.0",
    telemetry: {
      intent: "required",
    },
  });

  server.registerTool(
    "create_customer",
    {
      description: "Create a mock Autumn customer.",
      inputSchema: z
        .object({
          customer_id: z.string().min(1),
          email: z.string().email().optional(),
          name: z.string().optional(),
        })
        .strict(),
    },
    async (args): Promise<CallToolResult> => {
      const customer = await autumn.customers.create(args);
      return {
        content: [{ type: "text", text: JSON.stringify(customer) }],
        structuredContent: customer,
      };
    },
  );

  return server;
};

export const main = async () => {
  const server = createAutumnTestServer();
  await server.mcp.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
