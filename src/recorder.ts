import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ActorIdResolverInput,
  AnalyticsRecorder,
  InstrumentToolCallEvent,
  McpAnalyticsConfig,
  McpServerInfo,
  RecordSessionInitEvent,
  RecordToolCallEvent,
  RegisteredToolHandler,
  RequestExtra,
  ToolCallHandler,
  ToolDefinition,
  ToolHandlerContext,
  ToolRegistration,
} from "./types.js";
import {
  buildActorId,
  buildBatch,
  buildSessionInitBatch,
  buildToolCallEvent,
  normalizeRequestId,
  normalizeSessionId,
  normalizeStartedAt,
} from "./events.js";
import {
  createFlushableEmitter,
  defaultMcpAnalyticsConfig,
  resolveActorSeed,
  resolveMcpServerId,
} from "./emit.js";
import {
  decorateInputSchemaWithTelemetry,
  extractTelemetryArguments,
} from "./schema.js";

const createAnalyticsContext = async (
  config: McpAnalyticsConfig,
  input: ActorIdResolverInput,
): Promise<{ mcpServerId: string; actorId: string } | null> => {
  const mcpServerId = resolveMcpServerId(config);
  if (!mcpServerId) return null;

  const actorSeed = await resolveActorSeed(config, input);
  const actorId = buildActorId({
    mcpServerId,
    actorSeed,
  });

  return { mcpServerId, actorId };
};

export const createAnalyticsRecorder = (
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
): AnalyticsRecorder => {
  const { emitBatch, flush } = createFlushableEmitter(config);
  const sessionInitKeys = new Set<string>();

  const analyticsContextFor = async (input: ActorIdResolverInput) => {
    return createAnalyticsContext(config, input);
  };

  const decorateDefinitions = (defs: ToolDefinition[]) => {
    return defs.map((definition) => ({
      ...definition,
      inputSchema: decorateInputSchemaWithTelemetry(
        definition.inputSchema ?? { type: "object", properties: {} },
        config,
      ),
    }));
  };

  const recordSessionInit = async (event: RecordSessionInitEvent) => {
    const sessionId = normalizeSessionId(event.sessionId, event.extra);
    if (!sessionId) return;

    const context = await analyticsContextFor({
      ctx: event.ctx,
      extra: event.extra,
      headers: event.headers ?? event.extra?.requestInfo?.headers,
      authInfo: event.authInfo ?? event.extra?.authInfo,
    });
    if (!context) return;

    const finishedAtMs = Date.now();
    const startedAt = normalizeStartedAt({
      startedAt: event.startedAt,
      finishedAtMs,
    });
    const batch = buildSessionInitBatch({
      mcpServerId: context.mcpServerId,
      actorId: context.actorId,
      sessionId,
      requestId: event.requestId ?? randomUUID(),
      startedAt,
      extra: event.extra,
      sessionInitKeys,
    });

    if (batch) await emitBatch(batch);
  };

  const recordToolCall = async (event: RecordToolCallEvent) => {
    const context = await analyticsContextFor({
      ctx: event.ctx,
      extra: event.extra,
      headers: event.headers ?? event.extra?.requestInfo?.headers,
      authInfo: event.authInfo ?? event.extra?.authInfo,
      toolName: event.name,
      telemetry: event.telemetry,
    });
    if (!context) return;

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const durationMs = event.durationMs ?? 0;
    const startedAt = normalizeStartedAt({
      startedAt: event.startedAt,
      durationMs,
      finishedAtMs,
    });
    const requestId = normalizeRequestId(event.requestId, event.extra);
    const sessionId = normalizeSessionId(event.sessionId, event.extra);
    const errorMessage = event.error === undefined
      ? undefined
      : event.error instanceof Error
        ? event.error.message
        : String(event.error);

    const toolCallEvent = buildToolCallEvent({
      toolName: event.name,
      telemetry: event.telemetry,
      input: event.args,
      output: event.result,
      status: event.status,
      durationMs,
      errorMessage,
      mcpServerId: context.mcpServerId,
      actorId: context.actorId,
      sessionId,
      requestId,
      startedAt,
      finishedAt,
    });

    await emitBatch(
      buildBatch({
        event: toolCallEvent,
        extra: {
          ...(event.extra ?? {}),
          ...(sessionId ? { sessionId } : {}),
        },
        mcpServerId: context.mcpServerId,
        actorId: context.actorId,
        startedAt,
        sessionInitKeys,
      }),
    );
  };

  const registeredTools = new Map<
    string,
    {
      registration: ToolRegistration;
      handler: RegisteredToolHandler<unknown, unknown>;
    }
  >();

  const instrumentToolCall = async <T>(
    event: InstrumentToolCallEvent,
    handler: ToolCallHandler<T>,
  ): Promise<T> => {
    const { args, telemetry } = extractTelemetryArguments(event.args);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    try {
      const result = await handler(args);
      await recordToolCall({
        ...event,
        args,
        telemetry,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        status: "ok",
        result,
      });
      return result;
    } catch (error) {
      await recordToolCall({
        ...event,
        args,
        telemetry,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        status: "error",
        error,
      });
      throw error;
    }
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
      { name, args: rawArgs, ...context },
      (args) => tool.handler(args, context) as T | Promise<T>,
    );
  };

  let attachedServer: McpServer | null = null;

  const buildHandlerContext = (
    extra: RequestExtra | undefined,
  ): ToolHandlerContext => ({
    extra,
    sessionId: extra?.sessionId,
    requestId: extra?.requestId === undefined ? undefined : String(extra.requestId),
    authInfo: extra?.authInfo,
    headers: extra?.requestInfo?.headers,
    ctx: extra,
  });

  const registerWithServer = (
    server: McpServer,
    registration: ToolRegistration,
    handler: RegisteredToolHandler<unknown, unknown>,
  ) => {
    const originalHasInputSchema = registration.inputSchema !== undefined;
    const decoratedSchema = decorateInputSchemaWithTelemetry(
      registration.inputSchema,
      config,
    );

    server.registerTool(
      registration.name,
      {
        ...(registration.title !== undefined ? { title: registration.title } : {}),
        ...(registration.description !== undefined
          ? { description: registration.description }
          : {}),
        inputSchema: decoratedSchema,
      } as Parameters<typeof server.registerTool>[1],
      (async (...callbackArgs: unknown[]) => {
        const argsOrExtra = callbackArgs[0];
        const maybeExtra = callbackArgs[1];
        const rawArgs = originalHasInputSchema ? argsOrExtra : {};
        const extra = (originalHasInputSchema ? maybeExtra : argsOrExtra) as
          | RequestExtra
          | undefined;
        return instrumentToolCall(
          {
            name: registration.name,
            args: rawArgs,
            extra,
            sessionId: extra?.sessionId,
          },
          (strippedArgs) => handler(strippedArgs, buildHandlerContext(extra)),
        );
      }) as Parameters<typeof server.registerTool>[2],
    );
  };

  const tool = <TArgs = unknown, TResult = unknown>(
    registration: ToolRegistration,
    handler: RegisteredToolHandler<TArgs, TResult>,
  ) => {
    registeredTools.set(registration.name, {
      registration,
      handler: handler as RegisteredToolHandler<unknown, unknown>,
    });
    if (attachedServer) {
      registerWithServer(
        attachedServer,
        registration,
        handler as RegisteredToolHandler<unknown, unknown>,
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
    for (const { registration, handler } of registeredTools.values()) {
      registerWithServer(server, registration, handler);
    }
    return server;
  };

  const createMcpServer = (info: McpServerInfo) => {
    return attachToMcpServer(new McpServer(info));
  };

  const toolDefinitions = () => {
    return decorateDefinitions(
      Array.from(registeredTools.values()).map(({ registration }) => {
        const definition: ToolDefinition = { name: registration.name };
        if (registration.title !== undefined) definition.title = registration.title;
        if (registration.description !== undefined) {
          definition.description = registration.description;
        }
        if (registration.inputSchema !== undefined) {
          definition.inputSchema = registration.inputSchema;
        }
        return definition;
      }),
    );
  };

  const hasTool = (name: string) => registeredTools.has(name);

  return {
    decorateDefinitions,
    extractTelemetry: extractTelemetryArguments,
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
