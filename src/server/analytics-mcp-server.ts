import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";

export type TelemetryMode = "required" | "optional";
export type QueueDropPolicy = "drop_newest" | "drop_oldest";

export type AnalyticsServerConfig = {
  name: string;
  version: string;
  telemetry: {
    intent: TelemetryMode;
  };
  queue?: {
    maxEvents?: number;
    dropPolicy?: QueueDropPolicy;
  };
};

export type TelemetryEvent = {
  event: "tool_attempt" | "tool_rejected" | "tool_finished" | "tool_failed";
  request_id: string;
  tool_name: string;
  intent?: string;
  status: "attempted" | "rejected" | "succeeded" | "failed";
  duration_ms?: number;
  timestamp: string;
  error?: string;
};

type ToolConfig<Shape extends ZodRawShape> = {
  title?: string;
  description?: string;
  inputSchema: ZodObject<Shape>;
};

type ToolHandler<Args> = (args: Args) => Promise<CallToolResult> | CallToolResult;

type RegisteredTool = {
  originalSchema: ZodObject<ZodRawShape>;
  decoratedSchema: ZodObject<ZodRawShape>;
  handler: ToolHandler<unknown>;
};

type ToolTelemetry = {
  intent?: string;
};

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

export class BoundedTelemetryQueue {
  private readonly events: TelemetryEvent[] = [];
  private readonly maxEvents: number;
  private readonly dropPolicy: QueueDropPolicy;
  private droppedEvents = 0;

  constructor(options?: { maxEvents?: number; dropPolicy?: QueueDropPolicy }) {
    this.maxEvents = options?.maxEvents ?? 1000;
    this.dropPolicy = options?.dropPolicy ?? "drop_newest";
  }

  enqueue(event: TelemetryEvent) {
    if (this.events.length >= this.maxEvents) {
      this.droppedEvents += 1;
      if (this.dropPolicy === "drop_oldest") {
        this.events.shift();
      } else {
        return;
      }
    }

    this.events.push(event);
  }

  snapshot() {
    return [...this.events];
  }

  drain() {
    return this.events.splice(0);
  }

  getDroppedEventCount() {
    return this.droppedEvents;
  }
}

export type AnalyticsMcpServer = {
	readonly mcp: McpServer;
	readonly telemetryQueue: BoundedTelemetryQueue;
	registerTool<Shape extends ZodRawShape>(
		name: string,
		config: ToolConfig<Shape>,
		handler: ToolHandler<z.infer<ZodObject<Shape>>>,
	): void;
	callTool(name: string, rawArgs: unknown): Promise<CallToolResult>;
  getDecoratedInputSchema(name: string): ZodObject<ZodRawShape> | undefined;
  close(): Promise<void>;
};

export function createAnalyticsMcpServer(
  config: AnalyticsServerConfig,
): AnalyticsMcpServer {
  const mcp = new McpServer({ name: config.name, version: config.version });
  const telemetryQueue = new BoundedTelemetryQueue(config.queue);
  const tools = new Map<string, RegisteredTool>();

  const emit = (event: TelemetryEvent) => {
    telemetryQueue.enqueue(event);
  };

  const facade: AnalyticsMcpServer = {
    mcp,
    telemetryQueue,
    registerTool(name, toolConfig, handler) {
      if (tools.has(name)) {
        throw new Error(`Tool ${name} is already registered`);
      }

      const decoratedSchema = decorateInputSchema(
        toolConfig.inputSchema,
        config.telemetry.intent,
      );

      tools.set(name, {
        originalSchema: toolConfig.inputSchema,
        decoratedSchema,
        handler: handler as ToolHandler<unknown>,
      });

      mcp.registerTool(
        name,
        {
          title: toolConfig.title,
          description: toolConfig.description,
          inputSchema: decoratedSchema,
        },
        async (args) => facade.callTool(name, args),
      );
    },
    async callTool(name, rawArgs) {
      const tool = tools.get(name);
      if (!tool) throw new ToolValidationError(`Tool ${name} is not registered`);

      const requestId = randomUUID();
      const startedAt = performance.now();
      const telemetry = extractTelemetry(rawArgs);

      emit({
        event: "tool_attempt",
        request_id: requestId,
        tool_name: name,
        intent: telemetry?.intent,
        status: "attempted",
        timestamp: new Date().toISOString(),
      });

      const parsed = tool.decoratedSchema.safeParse(rawArgs);
      if (!parsed.success) {
        emit({
          event: "tool_rejected",
          request_id: requestId,
          tool_name: name,
          intent: telemetry?.intent,
          status: "rejected",
          duration_ms: durationSince(startedAt),
          timestamp: new Date().toISOString(),
          error: parsed.error.message,
        });
        throw new ToolValidationError(parsed.error.message);
      }

      const { telemetry: _telemetry, ...originalArgs } = parsed.data as Record<
        string,
        unknown
      >;

      try {
        const result = await tool.handler(originalArgs);
        emit({
          event: "tool_finished",
          request_id: requestId,
          tool_name: name,
          intent: telemetry?.intent,
          status: "succeeded",
          duration_ms: durationSince(startedAt),
          timestamp: new Date().toISOString(),
        });
        return result;
      } catch (error) {
        emit({
          event: "tool_failed",
          request_id: requestId,
          tool_name: name,
          intent: telemetry?.intent,
          status: "failed",
          duration_ms: durationSince(startedAt),
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    getDecoratedInputSchema(name) {
      return tools.get(name)?.decoratedSchema;
    },
    close() {
      telemetryQueue.drain();
      return mcp.close();
    },
  };

  return facade;
}

const decorateInputSchema = (
  schema: ZodObject<ZodRawShape>,
  telemetryMode: TelemetryMode,
) => {
  if ("telemetry" in schema.shape) {
    throw new Error("Cannot decorate a tool schema that already has telemetry");
  }

  const telemetrySchema =
    telemetryMode === "required"
      ? z.object({ intent: z.string().min(1) }).catchall(z.string())
      : z.object({ intent: z.string().min(1).optional() }).catchall(z.string()).optional();

  return schema.extend({
    telemetry: telemetrySchema as ZodTypeAny,
  });
};

const extractTelemetry = (rawArgs: unknown): ToolTelemetry | undefined => {
  if (!rawArgs || typeof rawArgs !== "object") return undefined;
  const telemetry = (rawArgs as { telemetry?: unknown }).telemetry;
  if (!telemetry || typeof telemetry !== "object") return undefined;
  const intent = (telemetry as { intent?: unknown }).intent;
  return typeof intent === "string" ? { intent } : {};
};

const durationSince = (startedAt: number) =>
  Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
