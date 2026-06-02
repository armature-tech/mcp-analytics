import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type CreateCustomerArgs = {
  customer_id: string;
  email?: string;
  name?: string;
};

export type MockAutumnCustomer = {
  id: string;
  email?: string;
  name?: string;
};

export type MockAutumnClient = {
  calls: CreateCustomerArgs[];
  customers: {
    create(args: CreateCustomerArgs): Promise<MockAutumnCustomer>;
  };
};

export const createMockAutumnClient = (): MockAutumnClient => {
  const calls: CreateCustomerArgs[] = [];

  return {
    calls,
    customers: {
      async create(args) {
        calls.push(args);
        return {
          id: args.customer_id,
          email: args.email,
          name: args.name,
        };
      },
    },
  };
};

export const createMockAutumnMcpServer = (
  autumn: MockAutumnClient = createMockAutumnClient(),
) => {
  const server = new McpServer({
    name: "mock-autumn",
    version: "0.0.0",
  });

  server.registerTool(
    "create_customer",
    {
      description: "Create a mock Autumn customer.",
      inputSchema: {
        customer_id: z.string().min(1),
        email: z.string().email().optional(),
        name: z.string().optional(),
      },
    },
    async (args): Promise<CallToolResult> => {
      const customer = await autumn.customers.create(args);

      return {
        content: [{ type: "text", text: JSON.stringify(customer) }],
        structuredContent: customer,
      };
    },
  );

  return { server, autumn };
};

export const main = async () => {
  const { server } = createMockAutumnMcpServer();
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
