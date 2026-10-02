import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnalyticsRecorder,
  McpAnalyticsConfig,
  McpServerInfo,
  RegisteredToolHandler,
  RequestExtra,
  TelemetryMode,
  ToolDefinition,
  ToolHandlerContext,
  ToolRegistration,
} from "./types.js";
import { defaultMcpAnalyticsConfig } from "./emit.js";
import {
  planToolTelemetry,
  TELEMETRY_PROPERTY_DESCRIPTION,
  USER_INTENT_DESCRIPTION,
} from "./schema.js";
import { isJsonObjectSchema, isRecord } from "./utils.js";
import type { JsonObjectSchema } from "./types.js";
import {
  getClientInfoForSessionId,
  installClientInfoCapture,
} from "./client-info-cache.js";
import {
  handleRequestCapability,
  isRequestCapabilityEnabled,
  isRequestCapabilityExplicit,
  REQUEST_CAPABILITY_ANNOTATIONS,
  REQUEST_CAPABILITY_DESCRIPTION,
  REQUEST_CAPABILITY_INPUT_SCHEMA,
  REQUEST_CAPABILITY_TOOL_NAME,
  REQUEST_CAPABILITY_ZOD_SHAPE,
} from "./request-capability.js";
import { createAnalyticsRecorderCore } from "./recorder-core.js";

const nudgeTelemetryDescriptions = (schema: unknown): unknown => {
  if (!isJsonObjectSchema(schema)) return schema;
  const telemetry = schema.properties?.telemetry;
  if (!isJsonObjectSchema(telemetry)) return schema;

  const userIntent = telemetry.properties?.user_intent;
  const nudgedTelemetry: JsonObjectSchema = {
    ...telemetry,
    description: TELEMETRY_PROPERTY_DESCRIPTION,
    properties: {
      ...(telemetry.properties ?? {}),
      ...(isRecord(userIntent)
        ? {
            user_intent: { ...userIntent, description: USER_INTENT_DESCRIPTION },
          }
        : {}),
    },
  };
  return {
    ...schema,
    properties: { ...schema.properties, telemetry: nudgedTelemetry },
  };
};

export const createAnalyticsRecorder = (
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
): AnalyticsRecorder => {
  // Patch the SDK's Server.prototype the first time any recorder is created
  // so that the very next `initialize` handshake feeds the per-session client
  // info cache. Without this the dashboard's "Client" column would stay at
  // "Unknown" for Mastra-wrapped tool calls, which can't reach the underlying
  // SDK Server from inside `tool.execute`.
  installClientInfoCapture();

  const registeredTools = new Map<
    string,
    {
      registration: ToolRegistration;
      handler: RegisteredToolHandler<unknown, unknown>;
      telemetryMode: TelemetryMode;
      internal: boolean;
    }
  >();

  // The transport-independent record pipeline lives in recorder-core.ts (so
  // the v2 adapter can reuse it without loading the v1 SDK); the hooks feed
  // it the two pieces of v1-specific state it must consult per event.
  const core = createAnalyticsRecorderCore(config, {
    clientInfoForSessionId: getClientInfoForSessionId,
    isToolTelemetryOwned: (name) =>
      registeredTools.get(name)?.telemetryMode === "owned",
  });
  const {
    extractTelemetry,
    recordToolCall,
    recordSessionInit,
    instrumentToolCall,
    flush,
  } = core;

  const decorateDefinitions = (defs: ToolDefinition[]) => {
    return defs.map((definition) => {
      const plan = planToolTelemetry(
        definition.name,
        definition.inputSchema ?? { type: "object", properties: {} },
        config,
      );
      // Owned/scrub tools pass through undecorated — their advertised schema
      // and description must keep matching what the handler actually receives.
      if (plan.mode !== "injected") {
        return { ...definition, inputSchema: plan.inputSchema };
      }
      return {
        ...definition,
        description: plan.applyDescription(
          typeof definition.description === "string"
            ? definition.description
            : undefined,
        ),
        inputSchema: nudgeTelemetryDescriptions(plan.inputSchema),
      };
    });
  };

  const dispatch = async <T = unknown>(
    name: string,
    rawArgs: unknown,
    context: ToolHandlerContext = {},
  ): Promise<T> => {
    const tool = registeredTools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return instrumentToolCall<T>(
      {
        name,
        args: rawArgs,
        telemetryMode: tool.telemetryMode,
        capabilityRequest: tool.internal,
        ...context,
      },
      (args) => tool.handler(args, context) as T | Promise<T>,
    );
  };

  let attachedServer: McpServer | null = null;

  const buildHandlerContext = (
    extra: RequestExtra | undefined,
  ): ToolHandlerContext => ({
    extra,
    sessionId: extra?.sessionId,
    // Deliberately NOT surfacing `extra.requestId` (the MCP JSON-RPC id) as
    // `context.requestId`: `dispatch` spreads the handler context into
    // `instrumentToolCall`, so a handler that forwards its context into a nested
    // tool call would seed that call's `event_id` with the JSON-RPC id — a
    // per-client counter that resets on reconnect — re-introducing the exact
    // collisions this fix removes. The id stays reachable via `context.extra`.
    authInfo: extra?.authInfo,
    headers: extra?.requestInfo?.headers,
    ctx: extra,
  });

  const registerWithServer = (
    server: McpServer,
    registration: ToolRegistration,
    handler: RegisteredToolHandler<unknown, unknown>,
    internal = false,
  ) => {
    const originalHasInputSchema = registration.inputSchema !== undefined;
    const plan = internal
      ? {
          mode: "scrub" as const,
          inputSchema: registration.inputSchema,
          applyDescription: (description: string | undefined) => description,
        }
      : planToolTelemetry(
          registration.name,
          registration.inputSchema,
          config,
        );
    // The MCP SDK passes (args, extra) to the callback whenever the registered
    // tool has an input schema, and just (extra) when it has none — so the
    // positional juggling below keys on what we actually registered, which for
    // owned/scrub tools is the caller's original (possibly absent) schema.
    const registeredHasInputSchema = plan.inputSchema !== undefined;
    // Same nudge `decorateDefinitions` applies in the registry path — the
    // caller-owned McpServer path must also tell agents to pass
    // telemetry.user_intent, or sessions arrive with no intent (ARM-24).
    // Owned/scrub tools keep their original description untouched.
    const description = plan.applyDescription(registration.description);

    server.registerTool(
      registration.name,
      {
        ...(registration.title !== undefined ? { title: registration.title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(registeredHasInputSchema ? { inputSchema: plan.inputSchema } : {}),
        ...(registration.outputSchema !== undefined
          ? { outputSchema: registration.outputSchema }
          : {}),
        ...(registration.annotations !== undefined
          ? { annotations: registration.annotations }
          : {}),
      } as Parameters<typeof server.registerTool>[1],
      (async (...callbackArgs: unknown[]) => {
        const argsOrExtra = callbackArgs[0];
        const maybeExtra = callbackArgs[1];
        const rawArgs = registeredHasInputSchema ? argsOrExtra : {};
        const extra = (registeredHasInputSchema ? maybeExtra : argsOrExtra) as
          | RequestExtra
          | undefined;
        return instrumentToolCall(
          {
            name: registration.name,
            args: rawArgs,
            extra,
            sessionId: extra?.sessionId,
            telemetryMode: plan.mode,
            capabilityRequest: internal,
          },
          (strippedArgs) =>
            handler(
              originalHasInputSchema ? strippedArgs : {},
              buildHandlerContext(extra),
            ),
        );
      }) as Parameters<typeof server.registerTool>[2],
    );
  };

  const tool = <TArgs = unknown, TResult = unknown>(
    registration: ToolRegistration,
    handler: RegisteredToolHandler<TArgs, TResult>,
  ) => {
    if (
      isRequestCapabilityEnabled(config)
      && registration.name === REQUEST_CAPABILITY_TOOL_NAME
      && isRequestCapabilityExplicit(config)
    ) {
      // Reserved only when the caller explicitly opted in. When the tool is on
      // merely by default, a customer tool of the same name takes precedence:
      // fall through so this registration overwrites the SDK-owned entry.
      throw new Error(
        `Tool name "${REQUEST_CAPABILITY_TOOL_NAME}" is reserved while armature.requestCapability is enabled.`,
      );
    }
    registeredTools.set(registration.name, {
      registration,
      handler: handler as RegisteredToolHandler<unknown, unknown>,
      telemetryMode: planToolTelemetry(
        registration.name,
        registration.inputSchema,
        config,
      ).mode,
      internal: false,
    });
    if (attachedServer) {
      registerWithServer(
        attachedServer,
        registration,
        handler as RegisteredToolHandler<unknown, unknown>,
        false,
      );
    }
    return (rawArgs: unknown, context: ToolHandlerContext = {}) =>
      dispatch<TResult>(registration.name, rawArgs, context);
  };

  const attachToMcpServer = (server: McpServer) => {
    if (attachedServer) {
      throw new Error("This recorder is already attached to an McpServer.");
    }
    attachedServer = server;
    for (const { registration, handler, internal } of registeredTools.values()) {
      registerWithServer(server, registration, handler, internal);
    }
    return server;
  };

  const createMcpServer = (info: McpServerInfo) => {
    return attachToMcpServer(new McpServer(info));
  };

  const toolDefinitions = () => {
    const definitions: ToolDefinition[] = [];
    for (const { registration, internal } of registeredTools.values()) {
      if (internal) {
        definitions.push({
          name: REQUEST_CAPABILITY_TOOL_NAME,
          description: REQUEST_CAPABILITY_DESCRIPTION,
          inputSchema: REQUEST_CAPABILITY_INPUT_SCHEMA,
          annotations: REQUEST_CAPABILITY_ANNOTATIONS,
        });
        continue;
      }
      const definition: ToolDefinition = { name: registration.name };
      if (registration.title !== undefined) definition.title = registration.title;
      if (registration.description !== undefined) {
        definition.description = registration.description;
      }
      if (registration.inputSchema !== undefined) {
        definition.inputSchema = registration.inputSchema;
      }
      if (registration.outputSchema !== undefined) {
        definition.outputSchema = registration.outputSchema;
      }
      if (registration.annotations !== undefined) {
        definition.annotations = registration.annotations;
      }
      definitions.push(...decorateDefinitions([definition]));
    }
    return definitions;
  };

  const hasTool = (name: string) => registeredTools.has(name);

  if (isRequestCapabilityEnabled(config)) {
    registeredTools.set(REQUEST_CAPABILITY_TOOL_NAME, {
      registration: {
        name: REQUEST_CAPABILITY_TOOL_NAME,
        description: REQUEST_CAPABILITY_DESCRIPTION,
        inputSchema: REQUEST_CAPABILITY_ZOD_SHAPE,
        annotations: REQUEST_CAPABILITY_ANNOTATIONS,
      },
      handler: handleRequestCapability,
      telemetryMode: "scrub",
      internal: true,
    });
  }

  return {
    decorateDefinitions,
    extractTelemetry,
    recordToolCall,
    recordSessionInit,
    instrumentToolCall,
    tool,
    dispatch,
    toolDefinitions,
    hasTool,
    attachToMcpServer,
    createMcpServer,
    flush,
  };
};
