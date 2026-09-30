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
import {
  appendTelemetryHint,
  planToolTelemetry,
  withoutRequestCapabilityHint,
} from "./schema.js";
import type { DescriptionLengthLogLevel, TelemetryMode } from "./types.js";
import { defaultMcpAnalyticsConfig } from "./emit.js";
import { deriveToolResultError, isRecord } from "./utils.js";
import {
  isRequestCapabilityEnabled,
  isRequestCapabilityExplicit,
  REQUEST_CAPABILITY_TOOL_NAME,
} from "./request-capability.js";

type WithAnalyticsContext = {
  config: McpAnalyticsConfig;
  recorder: AnalyticsRecorder;
  // Set once the factory returns and the SDK-owned tool is attached (or not).
  // Callbacks the factory scheduled keep this context, so later registrations
  // check their own server directly.
  resolved: boolean;
  // Tools registered while the factory ran whose hint names
  // request_capability, with the description they get if their server ends
  // up not listing it.
  requestCapabilityHints: Array<{
    server: McpServer;
    tool: unknown;
    toolName: string;
    // What we registered; a different value later means the factory updated it.
    hintedDescription: string | undefined;
    fallbackDescription: string | undefined;
    logLevel: DescriptionLengthLogLevel | undefined;
  }>;
};

const withAnalyticsStorage = new AsyncLocalStorage<WithAnalyticsContext>();
let prototypePatchInstalled = false;

// Servers a tool named request_capability was registered on: the SDK-owned
// one the recorder attaches, or a customer's own. Only the fallback for an
// SDK build without the tool registry below.
const serversListingRequestCapability = new WeakSet<McpServer>();

// Whether tools/list on `server` currently carries request_capability. Reads
// the SDK's registry (the same map and `enabled` filter tools/list uses), so
// a tool removed or disabled after registration no longer counts.
const listsRequestCapability = (server: McpServer) => {
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { enabled?: boolean } | undefined>;
  })._registeredTools;
  if (registry !== null && typeof registry === "object") {
    return registry[REQUEST_CAPABILITY_TOOL_NAME]?.enabled === true;
  }
  return serversListingRequestCapability.has(server);
};

// Mirrors the SDK's `isZodTypeLike`/`isZodRawShapeCompat` checks closely enough
// to disambiguate the overloads of `server.tool(...)`: a raw shape is a plain
// object whose values include at least one Zod schema, while a Zod schema
// instance carries `_def` (v3) or `_zod` (v4).
const isZodSchemaLike = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return "_def" in value || "_zod" in value;
};

const isZodRawShapeLike = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (isZodSchemaLike(value)) return false;
  if (Object.keys(value).length === 0) return true;
  return Object.values(value).some(isZodSchemaLike);
};

type ParsedToolArgs = {
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  callback: ToolCallback;
};

// Mirrors @modelcontextprotocol/sdk/server/mcp.js `tool(name, ...rest)` argument
// parsing so we can normalise every overload through our patched `registerTool`.
const parseDeprecatedToolArgs = (rest: unknown[]): ParsedToolArgs => {
  const args = [...rest];
  let description: string | undefined;
  let inputSchema: unknown;
  let annotations: unknown;
  if (typeof args[0] === "string") {
    description = args.shift() as string;
  }
  if (args.length > 1) {
    const firstArg = args[0];
    if (isZodRawShapeLike(firstArg)) {
      inputSchema = args.shift();
      if (
        args.length > 1 &&
        isRecord(args[0]) &&
        !isZodRawShapeLike(args[0])
      ) {
        annotations = args.shift();
      }
    } else if (isRecord(firstArg)) {
      annotations = args.shift();
    }
  }
  const callback = args[0] as ToolCallback;
  return { description, inputSchema, annotations, callback };
};

const wrapCallbackWithAnalytics = (
  name: string,
  cb: ToolCallback,
  // The SDK invokes the wrapped callback according to the schema we REGISTERED
  // (args + extra when present, just extra when absent); the original callback
  // expects arguments according to the schema the CUSTOMER declared. The two
  // differ for schema-less tools in injected mode, so both flags are needed.
  originalHasInputSchema: boolean,
  registeredHasInputSchema: boolean,
  telemetryMode: TelemetryMode,
  ctx: WithAnalyticsContext,
): ToolCallback => {
  const { recorder } = ctx;
  return async (argsOrExtra: unknown, maybeExtra?: unknown) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const requestId = randomUUID();
    const extra = (registeredHasInputSchema ? maybeExtra : argsOrExtra) as
      | RequestExtra
      | undefined;
    const { args, telemetry } = recorder.extractTelemetry(
      registeredHasInputSchema ? argsOrExtra : undefined,
      telemetryMode,
    );

    try {
      const output = originalHasInputSchema
        ? await cb(args, extra)
        : await cb(extra);

      // A returned MCP error result (`isError: true`) is a failed call even
      // though the callback resolved; record it as an error while returning the
      // original output to the caller untouched.
      const resultError = deriveToolResultError(output);
      await recorder.recordToolCall({
        name,
        args,
        telemetry,
        extra,
        requestId,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        ...(resultError === undefined
          ? { status: "ok" as const, result: output }
          : { status: "error" as const, result: output, error: resultError }),
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
};

const installPrototypePatchOnce = () => {
  if (prototypePatchInstalled) return;
  prototypePatchInstalled = true;

  const prototype = McpServer.prototype as unknown as {
    registerTool: RegisterTool;
    tool: (this: McpServer, name: string, ...rest: unknown[]) => unknown;
  };
  const originalRegisterTool = prototype.registerTool;
  const originalTool = prototype.tool;

  prototype.registerTool = function patchedRegisterTool(
    this: McpServer,
    name: string,
    toolConfig: ToolConfig,
    cb: ToolCallback,
  ) {
    const ctx = withAnalyticsStorage.getStore();
    if (!ctx) {
      const registered = originalRegisterTool.call(this, name, toolConfig, cb);
      if (name === REQUEST_CAPABILITY_TOOL_NAME) serversListingRequestCapability.add(this);
      return registered;
    }

    const { config } = ctx;
    const originalHasInputSchema = toolConfig.inputSchema !== undefined;
    const plan = planToolTelemetry(
      name,
      toolConfig.inputSchema,
      config,
      ctx.resolved
        ? { requestCapability: listsRequestCapability(this) }
        : {},
    );
    const registeredHasInputSchema = plan.inputSchema !== undefined;
    const description = plan.applyDescription(toolConfig.description);
    const instrumentedConfig = {
      ...toolConfig,
      ...(description !== undefined ? { description } : {}),
      ...(registeredHasInputSchema ? { inputSchema: plan.inputSchema } : {}),
    };
    const wrappedCallback = wrapCallbackWithAnalytics(
      name,
      cb,
      originalHasInputSchema,
      registeredHasInputSchema,
      plan.mode,
      ctx,
    );

    const registered = originalRegisterTool.call(
      this,
      name,
      instrumentedConfig,
      wrappedCallback,
    );
    if (name === REQUEST_CAPABILITY_TOOL_NAME) serversListingRequestCapability.add(this);
    if (!ctx.resolved && plan.mode === "injected" && isRequestCapabilityEnabled(config)) {
      ctx.requestCapabilityHints.push({
        server: this,
        tool: registered,
        toolName: name,
        hintedDescription: description,
        fallbackDescription: appendTelemetryHint(toolConfig.description, {
          toolName: name,
          logLevel: config.armature?.descriptionLengthLogLevel,
        }),
        logLevel: config.armature?.descriptionLengthLogLevel,
      });
    }
    return registered;
  };

  // PRIA and other older codebases still use the deprecated `server.tool(...)`
  // overloads. Patch them too — we normalise into our patched `registerTool`
  // so decoration and wrapping have a single code path.
  prototype.tool = function patchedTool(
    this: McpServer,
    name: string,
    ...rest: unknown[]
  ) {
    const ctx = withAnalyticsStorage.getStore();
    if (!ctx) {
      return originalTool.call(this, name, ...rest);
    }

    const { description, inputSchema, annotations, callback } =
      parseDeprecatedToolArgs(rest);
    const config: ToolConfig = {};
    if (description !== undefined) config.description = description;
    if (inputSchema !== undefined) config.inputSchema = inputSchema;
    if (annotations !== undefined) config.annotations = annotations;
    return (this as unknown as { registerTool: RegisterTool }).registerTool(
      name,
      config,
      callback,
    );
  };
};

export const withMcpAnalytics = <ServerFactoryResult>(
  config: McpAnalyticsConfig,
  createServer: () => ServerFactoryResult,
): WithMcpAnalyticsResult<ServerFactoryResult> => {
  const recorder = createAnalyticsRecorder(config);
  installPrototypePatchOnce();
  const ctx: WithAnalyticsContext = {
    config,
    recorder,
    resolved: false,
    requestCapabilityHints: [],
  };
  const result = withAnalyticsStorage.run(ctx, createServer);
  // Customer tools registered inside the factory are handled by the
  // prototype patch above. The opt-in SDK-owned tool lives in the recorder's
  // private registry, so attach only after leaving AsyncLocalStorage: this
  // registers it once without adding telemetry fields or mutating its exact
  // description.
  if (isRequestCapabilityEnabled(config) && !(result instanceof McpServer)) {
    // Only a hard error when the caller explicitly opted in. A server that is
    // request_capability-on merely by default and doesn't return an McpServer
    // silently skips injection instead of breaking on upgrade.
    if (isRequestCapabilityExplicit(config)) {
      throw new Error(
        "armature.requestCapability requires the server factory to return an McpServer instance.",
      );
    }
  }
  if (isRequestCapabilityEnabled(config) && result instanceof McpServer) {
    try {
      recorder.attachToMcpServer(result);
    } catch (error) {
      const collision = error instanceof Error && /already registered/i.test(error.message);
      // A pre-existing tool of the same name is reserved only when the caller
      // explicitly opted in; on-by-default yields to the customer's tool.
      if (collision && isRequestCapabilityExplicit(config)) {
        throw new Error(
          'Tool name "request_capability" is reserved while armature.requestCapability is enabled.',
          { cause: error },
        );
      }
      if (!collision) throw error;
    }
  }
  // Tools registered on a server that does not list request_capability (the
  // factory returned something else, or registered on another server) must
  // not point agents at it.
  ctx.resolved = true;
  for (const hint of ctx.requestCapabilityHints) {
    if (
      !listsRequestCapability(hint.server)
      && hint.tool !== null
      && typeof hint.tool === "object"
    ) {
      const tool = hint.tool as { description?: string };
      // Keep a description the factory updated after registration; only its
      // hint changes.
      tool.description = tool.description === hint.hintedDescription
        ? hint.fallbackDescription
        : withoutRequestCapabilityHint(tool.description, hint.toolName, hint.hintedDescription, hint.logLevel);
    }
  }
  ctx.requestCapabilityHints.length = 0;
  return { result, recorder };
};

export const createMcpAnalyticsServer = <ServerFactoryResult>(
  createServer: () => ServerFactoryResult,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
): ServerFactoryResult => {
  return withMcpAnalytics(config, createServer).result;
};
