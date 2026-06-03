import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnalyticsRecorder,
  McpAnalyticsConfig,
  RegisterTool,
  RequestExtra,
  ToolCallback,
  ToolConfig,
  WithMcpAnalyticsResult,
} from "./types.js";
import { createAnalyticsRecorder } from "./recorder.js";
import { decorateInputSchemaWithTelemetry } from "./schema.js";
import { defaultMcpAnalyticsConfig } from "./emit.js";

type WithAnalyticsContext = {
  config: McpAnalyticsConfig;
  recorder: AnalyticsRecorder;
};

const withAnalyticsStorage = new AsyncLocalStorage<WithAnalyticsContext>();
let prototypePatchInstalled = false;

const installPrototypePatchOnce = () => {
  if (prototypePatchInstalled) return;
  prototypePatchInstalled = true;

  const prototype = McpServer.prototype as unknown as {
    registerTool: RegisterTool;
  };
  const originalRegisterTool = prototype.registerTool;

  prototype.registerTool = function patchedRegisterTool(
    this: McpServer,
    name: string,
    toolConfig: ToolConfig,
    cb: ToolCallback,
  ) {
    const ctx = withAnalyticsStorage.getStore();
    if (!ctx) {
      return originalRegisterTool.call(this, name, toolConfig, cb);
    }

    const { config, recorder } = ctx;
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
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const requestId = randomUUID();
      const extra = (originalHasInputSchema ? maybeExtra : argsOrExtra) as RequestExtra | undefined;
      const { args, telemetry } = recorder.extractTelemetry(argsOrExtra);

      try {
        const output = originalHasInputSchema
          ? await cb(args, maybeExtra)
          : await cb(maybeExtra ?? argsOrExtra);

        await recorder.recordToolCall({
          name,
          args,
          telemetry,
          extra,
          requestId,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          status: "ok",
          result: output,
        });

        return output;
      } catch (error) {
        await recorder.recordToolCall({
          name,
          args,
          telemetry,
          extra,
          requestId,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          status: "error",
          error,
        });

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
};

export const withMcpAnalytics = <ServerFactoryResult>(
  config: McpAnalyticsConfig,
  createServer: () => ServerFactoryResult,
): WithMcpAnalyticsResult<ServerFactoryResult> => {
  const recorder = createAnalyticsRecorder(config);
  installPrototypePatchOnce();
  const result = withAnalyticsStorage.run(
    { config, recorder },
    createServer,
  );
  return { result, recorder };
};

export const createMcpAnalyticsServer = <ServerFactoryResult>(
  createServer: () => ServerFactoryResult,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
): ServerFactoryResult => {
  return withMcpAnalytics(config, createServer).result;
};
