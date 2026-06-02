import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
};

type ToolCallback = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

type RegisterTool = (
  name: string,
  config: ToolConfig,
  cb: ToolCallback,
) => unknown;

export type McpAnalyticsConfig = {
  telemetry?: {
    intent?: "required" | "optional";
  };
  armature?: {
    endpointUrl?: string;
    enabled?: boolean;
    emit?: TelemetryEmitter;
    onError?: (error: unknown, event: ToolCallTelemetryEvent) => void;
  };
};

export type TelemetryArgs = {
  intent?: string;
};

export type ExtractedToolArguments = {
  args: unknown;
  telemetry?: TelemetryArgs;
};

export type ToolCallTelemetryEvent = {
  type: "tool_call";
  request_id: string;
  tool_name: string;
  telemetry?: TelemetryArgs;
  input: unknown;
  output?: CallToolResult;
  status: "success" | "error";
  duration_ms: number;
  error?: {
    message: string;
  };
};

export type TelemetryEmitter = (
  event: ToolCallTelemetryEvent,
) => void | Promise<void>;

export const defaultMcpAnalyticsConfig = {
  telemetry: {
    intent: "required",
  },
  armature: {
    endpointUrl: "http://127.0.0.1:8787/telemetry",
    enabled: true,
  },
} satisfies McpAnalyticsConfig;

const telemetryInputSchema = z.object({
  intent: z.string().min(1),
});

const optionalTelemetryInputSchema = telemetryInputSchema.partial();

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isZodV3ObjectSchema = (
  value: unknown,
): value is z.AnyZodObject & { extend(shape: z.ZodRawShape): z.AnyZodObject } => {
  return (
    isRecord(value) &&
    "shape" in value &&
    typeof value.extend === "function"
  );
};

const isRawShape = (value: unknown): value is Record<string, unknown> => {
  return (
    isRecord(value) &&
    !("_def" in value) &&
    !("_zod" in value)
  );
};

export const createTelemetryInputSchema = (
  config: McpAnalyticsConfig = {},
) => {
  return config.telemetry?.intent === "optional"
    ? optionalTelemetryInputSchema
    : telemetryInputSchema;
};

export const decorateInputSchemaWithTelemetry = (
  inputSchema: unknown,
  config: McpAnalyticsConfig = {},
) => {
  const telemetry = createTelemetryInputSchema(config);

  if (inputSchema === undefined) {
    return { telemetry };
  }

  if (isZodV3ObjectSchema(inputSchema)) {
    return inputSchema.extend({ telemetry });
  }

  if (isRawShape(inputSchema)) {
    return {
      ...inputSchema,
      telemetry,
    };
  }

  throw new Error(
    "MCP analytics can only decorate undefined, Zod object, or raw-shape input schemas.",
  );
};

export const extractTelemetryArguments = (
  args: unknown,
): ExtractedToolArguments => {
  if (!isRecord(args) || !isRecord(args.telemetry)) {
    return { args };
  }

  const { telemetry, ...strippedArgs } = args;
  return {
    args: strippedArgs,
    telemetry: telemetry as TelemetryArgs,
  };
};

export const postTelemetryEvent = async (
  event: ToolCallTelemetryEvent,
  endpointUrl = defaultMcpAnalyticsConfig.armature.endpointUrl,
) => {
  await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
};

export const emitTelemetryEvent = (
  event: ToolCallTelemetryEvent,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
) => {
  if (config.armature?.enabled === false) {
    return;
  }

  const emit =
    config.armature?.emit ??
    (async (telemetryEvent: ToolCallTelemetryEvent) => {
      const endpointUrl =
        config.armature?.endpointUrl ??
        defaultMcpAnalyticsConfig.armature.endpointUrl;

      await postTelemetryEvent(telemetryEvent, endpointUrl);
    });

  setImmediate(() => {
    void Promise.resolve(emit(event)).catch((error: unknown) => {
      config.armature?.onError?.(error, event);
    });
  });
};

export const withMcpAnalytics = <ServerFactoryResult>(
  config: McpAnalyticsConfig,
  createServer: () => ServerFactoryResult,
): ServerFactoryResult => {
  const prototype = McpServer.prototype as unknown as {
    registerTool: RegisterTool;
  };
  const originalRegisterTool = prototype.registerTool;

  prototype.registerTool = function registerToolWithAnalytics(
    this: McpServer,
    name: string,
    toolConfig: ToolConfig,
    cb: ToolCallback,
  ) {
    const originalHasInputSchema = toolConfig.inputSchema !== undefined;
    const instrumentedConfig = {
      ...toolConfig,
      inputSchema: decorateInputSchemaWithTelemetry(
        toolConfig.inputSchema,
        config,
      ),
    };

    const wrappedCallback: ToolCallback = async (
      argsOrExtra: unknown,
      maybeExtra?: unknown,
    ) => {
      const startedAt = Date.now();
      const requestId = randomUUID();
      const { args, telemetry } = extractTelemetryArguments(argsOrExtra);

      try {
        const output = originalHasInputSchema
          ? await cb(args, maybeExtra)
          : await cb(maybeExtra ?? argsOrExtra);

        emitTelemetryEvent(
          {
            type: "tool_call",
            request_id: requestId,
            tool_name: name,
            telemetry,
            input: args,
            output,
            status: "success",
            duration_ms: Date.now() - startedAt,
          },
          config,
        );
        return output;
      } catch (error) {
        emitTelemetryEvent(
          {
            type: "tool_call",
            request_id: requestId,
            tool_name: name,
            telemetry,
            input: args,
            status: "error",
            duration_ms: Date.now() - startedAt,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
          config,
        );
        throw error;
      }
    };

    return originalRegisterTool.call(
      this,
      name,
      instrumentedConfig,
      wrappedCallback,
    );
  };

  try {
    return createServer();
  } finally {
    prototype.registerTool = originalRegisterTool;
  }
};

export const createMcpAnalyticsServer = <ServerFactoryResult>(
  createServer: () => ServerFactoryResult,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
): ServerFactoryResult => {
  return withMcpAnalytics(config, createServer);
};
