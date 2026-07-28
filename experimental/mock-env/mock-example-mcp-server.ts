import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";

export type CreateCustomerArgs = {
  customer_id: string;
  email?: string;
  name?: string;
};

export type MockExampleCustomer = {
  id: string;
  email?: string;
  name?: string;
};

export type MockExampleClient = {
  calls: CreateCustomerArgs[];
  customers: {
    create(args: CreateCustomerArgs): Promise<MockExampleCustomer>;
  };
};

export const createMockExampleClient = (): MockExampleClient => {
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

export const createMockExampleMcpServer = (
  exampleMcp: MockExampleClient = createMockExampleClient(),
) => {
  const server = new McpServer({
    name: "mock-example",
    version: "0.0.0",
  });

  server.registerTool(
    "create_customer",
    {
      description: "Create a mock Example MCP customer.",
      // Dev-tree two-zod situation: the workspace hoists SDK 1.26.0 next to
      // the app's zod 4.x, so the SDK's declaration of `AnySchema` binds to a
      // different zod package instance than this file's zod 3.25.x import.
      // The SDK accepts zod v3 schemas at runtime (it feature-detects `_def`
      // vs `_zod`); only the nominal class types disagree, hence the cast.
      inputSchema: {
        customer_id: z.string().min(1),
        email: z.string().email().optional(),
        name: z.string().optional(),
      } as unknown as ZodRawShapeCompat,
    },
    async (args): Promise<CallToolResult> => {
      const customer = await exampleMcp.customers.create(
        args as CreateCustomerArgs,
      );

      return {
        content: [{ type: "text", text: JSON.stringify(customer) }],
        structuredContent: customer,
      };
    },
  );

  return { server, exampleMcp };
};

export const main = async () => {
  const { server } = createMockExampleMcpServer();
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
