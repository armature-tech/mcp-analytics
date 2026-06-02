import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  BoundedTelemetryQueue,
  ToolValidationError,
  createAnalyticsMcpServer,
} from "../src/index.js";
import { createAutumnTestServer } from "../src/testing/autumn-test-server.js";

describe("analytics MCP server facade", () => {
  test("decorates a strict object schema with required telemetry", () => {
    const server = createAutumnTestServer();
    const schema = server.getDecoratedInputSchema("create_customer");

    expect(schema).toBeDefined();
    expect(schema?.shape.telemetry).toBeDefined();
  });

  test("strips telemetry before calling the original handler", async () => {
    const receivedArgs: unknown[] = [];
    const server = createAnalyticsMcpServer({
      name: "test",
      version: "0.0.0",
      telemetry: { intent: "required" },
    });

    server.registerTool(
      "create_customer",
      {
        inputSchema: z
          .object({
            customer_id: z.string(),
            email: z.string().optional(),
          })
          .strict(),
      },
      async (args) => {
        receivedArgs.push(args);
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    await server.callTool("create_customer", {
      customer_id: "cus_1",
      email: "alice@example.com",
      telemetry: { intent: "onboard_customer" },
    });

    expect(receivedArgs).toEqual([
      {
        customer_id: "cus_1",
        email: "alice@example.com",
      },
    ]);
    expect(server.telemetryQueue.snapshot().map((event) => event.event)).toEqual([
      "tool_attempt",
      "tool_finished",
    ]);
  });

  test("observes rejected calls before the original handler runs", async () => {
    let called = false;
    const server = createAnalyticsMcpServer({
      name: "test",
      version: "0.0.0",
      telemetry: { intent: "required" },
    });

    server.registerTool(
      "create_customer",
      {
        inputSchema: z.object({ customer_id: z.string() }).strict(),
      },
      async () => {
        called = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    await expect(
      server.callTool("create_customer", { customer_id: "cus_1" }),
    ).rejects.toBeInstanceOf(ToolValidationError);

    expect(called).toBe(false);
    const events = server.telemetryQueue.snapshot();
    expect(events.map((event) => event.event)).toEqual([
      "tool_attempt",
      "tool_rejected",
    ]);
    expect(events[0]?.request_id).toBe(events[1]?.request_id);
  });

  test("emits tool_failed with the same request id when the handler throws", async () => {
    const server = createAnalyticsMcpServer({
      name: "test",
      version: "0.0.0",
      telemetry: { intent: "required" },
    });

    server.registerTool(
      "explode",
      {
        inputSchema: z.object({ value: z.string() }).strict(),
      },
      async () => {
        throw new Error("boom");
      },
    );

    await expect(
      server.callTool("explode", {
        value: "x",
        telemetry: { intent: "test_failure" },
      }),
    ).rejects.toThrow("boom");

    const events = server.telemetryQueue.snapshot();
    expect(events.map((event) => event.event)).toEqual([
      "tool_attempt",
      "tool_failed",
    ]);
    expect(events[0]?.request_id).toBe(events[1]?.request_id);
    expect(events[1]?.error).toBe("boom");
  });

  test("bounded queue can drop oldest events", () => {
    const queue = new BoundedTelemetryQueue({
      maxEvents: 1,
      dropPolicy: "drop_oldest",
    });

    queue.enqueue({
      event: "tool_attempt",
      request_id: "one",
      tool_name: "a",
      status: "attempted",
      timestamp: new Date().toISOString(),
    });
    queue.enqueue({
      event: "tool_attempt",
      request_id: "two",
      tool_name: "b",
      status: "attempted",
      timestamp: new Date().toISOString(),
    });

    expect(queue.snapshot().map((event) => event.request_id)).toEqual(["two"]);
    expect(queue.getDroppedEventCount()).toBe(1);
  });

  test("mock Autumn server never receives telemetry", async () => {
    const autumnArgs: unknown[] = [];
    const server = createAutumnTestServer({
      customers: {
        async create(args) {
          autumnArgs.push(args);
          return { id: args.customer_id, email: args.email, name: args.name };
        },
      },
    });

    await server.callTool("create_customer", {
      customer_id: "cus_1",
      email: "alice@example.com",
      telemetry: { intent: "onboard_customer" },
    });

    expect(autumnArgs).toEqual([
      {
        customer_id: "cus_1",
        email: "alice@example.com",
      },
    ]);
  });

  test("works over real MCP tools/list and tools/call requests", async () => {
    const autumnArgs: unknown[] = [];
    const server = createAutumnTestServer({
      customers: {
        async create(args) {
          autumnArgs.push(args);
          return { id: args.customer_id, email: args.email, name: args.name };
        },
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const toolList = await client.listTools();
      const createCustomer = toolList.tools.find(
        (tool) => tool.name === "create_customer",
      );

      expect(createCustomer?.inputSchema.properties).toHaveProperty("telemetry");
      expect(createCustomer?.inputSchema.required).toContain("telemetry");

      const result = await client.callTool({
        name: "create_customer",
        arguments: {
          customer_id: "cus_1",
          email: "alice@example.com",
          telemetry: { intent: "onboard_customer" },
        },
      });

      expect(result.structuredContent).toEqual({
        id: "cus_1",
        email: "alice@example.com",
      });
      expect(autumnArgs).toEqual([
        {
          customer_id: "cus_1",
          email: "alice@example.com",
        },
      ]);

      await expect(
        client.callTool({
          name: "create_customer",
          arguments: {
            customer_id: "cus_2",
            email: "bob@example.com",
          },
        }),
      ).rejects.toThrow();

      expect(server.telemetryQueue.snapshot().map((event) => event.event)).toEqual([
        "tool_attempt",
        "tool_finished",
        "tool_attempt",
        "tool_rejected",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
