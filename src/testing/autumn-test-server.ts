import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodObject, type ZodRawShape } from "zod";
import {
	createAnalyticsMcpServer,
	type AnalyticsMcpServer,
} from "../server/analytics-mcp-server.js";

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

type ToolRegistrar = {
	registerTool<Shape extends ZodRawShape>(
		name: string,
		config: {
			description?: string;
			inputSchema: ZodObject<Shape>;
		},
		handler: (
			args: z.infer<ZodObject<Shape>>,
		) => Promise<CallToolResult> | CallToolResult,
	): void;
};

const createCustomerInputSchema = z
	.object({
		customer_id: z.string().min(1),
		email: z.string().email().optional(),
		name: z.string().optional(),
	})
	.strict();

export const registerAutumnCustomerTools = (
	registrar: ToolRegistrar,
	autumn: MockAutumnClient,
) => {
	registrar.registerTool(
    "create_customer",
    {
      description: "Create a mock Autumn customer.",
      inputSchema: createCustomerInputSchema,
    },
    async (args): Promise<CallToolResult> => {
      const customer = await autumn.customers.create(args);
      return {
        content: [{ type: "text", text: JSON.stringify(customer) }],
        structuredContent: customer,
      };
    },
  );
};

export type UninstrumentedAutumnTestServer = {
	mcp: McpServer;
};

export const createUninstrumentedAutumnTestServer = (
	autumn: MockAutumnClient = createMockAutumnClient(),
): UninstrumentedAutumnTestServer => {
	const mcp = new McpServer({
		name: "autumn-uninstrumented",
		version: "0.0.0",
	});
	const registrar: ToolRegistrar = {
		registerTool(name, config, handler) {
			mcp.registerTool(
				name,
				{
					description: config.description,
					inputSchema: config.inputSchema.shape,
				},
				handler as never,
			);
		},
	};

	registerAutumnCustomerTools(registrar, autumn);

	return { mcp };
};

export const createInstrumentedAutumnTestServer = (
  autumn: MockAutumnClient = createMockAutumnClient(),
): AnalyticsMcpServer => {
  const server = createAnalyticsMcpServer({
    name: "autumn-instrumented",
    version: "0.0.0",
  });

  registerAutumnCustomerTools(server, autumn);

  return server;
};

export const createAutumnTestServer = createInstrumentedAutumnTestServer;

export const main = async () => {
  const server = createInstrumentedAutumnTestServer();
  await server.mcp.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
