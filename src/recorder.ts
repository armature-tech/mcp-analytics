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
} from "./emit.js";
import {
  appendTelemetryHint,
  decorateInputSchemaWithTelemetry,
  extractTelemetryArguments,
  INTENT_DESCRIPTION,
  TELEMETRY_PROPERTY_DESCRIPTION,
} from "./schema.js";
import { createBoundedKeySet, deriveToolResultError, headerValue, isJsonObjectSchema, isRecord, workflowRunIdFromHeaders } from "./utils.js";
import type { HeaderBag, JsonObjectSchema } from "./types.js";
import { processScopedSessionId } from "./stdio-session.js";
import {
  getClientInfoForSessionId,
  installClientInfoCapture,
} from "./client-info-cache.js";
import { parseStatelessSessionClientInfo } from "./stateless-http.js";

const nudgeTelemetryDescriptions = (schema: unknown): unknown => {
  if (!isJsonObjectSchema(schema)) return schema;
  const telemetry = schema.properties?.telemetry;
  if (!isJsonObjectSchema(telemetry)) return schema;

  const intent = telemetry.properties?.intent;
  const nudgedTelemetry: JsonObjectSchema = {
    ...telemetry,
    description: TELEMETRY_PROPERTY_DESCRIPTION,
    properties: {
      ...(telemetry.properties ?? {}),
      ...(isRecord(intent)
        ? {
            intent: { ...intent, description: INTENT_DESCRIPTION },
          }
        : {}),
    },
  };
  return {
    ...schema,
    properties: { ...schema.properties, telemetry: nudgedTelemetry },
  };
};

const createAnalyticsContext = async (
  config: McpAnalyticsConfig,
  input: ActorIdResolverInput,
): Promise<{ actorId: string }> => {
  const actorSeed = await resolveActorSeed(config, input);
  return { actorId: buildActorId({ actorSeed }) };
};

export const createAnalyticsRecorder = (
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
): AnalyticsRecorder => {
  const { emitBatch, flush } = createFlushableEmitter(config);
  // Tracks which (actorId, sessionId) pairs have already emitted a session_init,
  // so we emit it at most once per session. Bounded with FIFO eviction: MCP
  // gives no reliable session-closed signal, so an unbounded set would leak on
  // long-running servers with high session churn. Eviction is safe because the
  // session_init event_id is now stable per (actorId, sessionId), so a re-emit
  // after eviction collapses to the same id at ingest. 10k × ~60 bytes ≈ 600KB.
  const sessionInitKeys = createBoundedKeySet(10_000);

  // Patch the SDK's Server.prototype the first time any recorder is created
  // so that the very next `initialize` handshake feeds the per-session client
  // info cache. Without this the dashboard's "Client" column would stay at
  // "Unknown" for Mastra-wrapped tool calls, which can't reach the underlying
  // SDK Server from inside `tool.execute`.
  installClientInfoCapture();

  const analyticsContextFor = async (input: ActorIdResolverInput) => {
    return createAnalyticsContext(config, input);
  };

  const decorateDefinitions = (defs: ToolDefinition[]) => {
    return defs.map((definition) => {
      const inputSchema = nudgeTelemetryDescriptions(
        decorateInputSchemaWithTelemetry(
          definition.inputSchema ?? { type: "object", properties: {} },
          config,
        ),
      );
      return {
        ...definition,
        description: appendTelemetryHint(
          typeof definition.description === "string"
            ? definition.description
            : undefined,
        ),
        inputSchema,
      };
    });
  };

  // Explicit caller-supplied workflowRunId wins; otherwise derive it from
  // the x-armature-workflow-run-id header the Armature run dispatcher adds
  // to MCP connections opened by workflow runs. Either way the resulting
  // events are stamped is_workflow so Session Analytics excludes them.
  const resolveWorkflowRunId = (event: {
    workflowRunId?: string;
    headers?: RecordSessionInitEvent["headers"];
    extra?: RequestExtra;
  }) => {
    return event.workflowRunId
      ?? workflowRunIdFromHeaders(event.headers ?? event.extra?.requestInfo?.headers);
  };

  // Session id, in falling priority: explicit event/extra value, transport
  // `Mcp-Session-Id` header, then — only for requests with no HTTP headers at
  // all (stdio, in-process) — the process-scoped fallback. Stdio transports
  // never carry a session id, and events shipped with `session_id_hint: null`
  // get bucketed per-actor-per-day at ingest, merging distinct CLI
  // conversations into one activity (see stdio-session.ts). Requests that DO
  // carry headers are excluded from the fallback: many sessions share a
  // long-lived HTTP server process, so the absence of a session id there must
  // stay visible to ingest instead of being glued to one process id.
  const resolveSessionId = (event: {
    sessionId?: string;
    extra?: RequestExtra;
    headers?: HeaderBag;
  }): string | undefined => {
    const normalized = normalizeSessionId(event.sessionId, event.extra);
    if (normalized) return normalized;
    const headers = event.headers ?? event.extra?.requestInfo?.headers;
    // Loose == null: an explicit `headers: null` from an untyped JS caller
    // means the same as absent — there is no HTTP request.
    if (headers == null) return processScopedSessionId();
    const fromHeaders = headerValue(headers, "mcp-session-id")?.trim();
    return fromHeaders ? fromHeaders : undefined;
  };

  const recordSessionInit = async (event: RecordSessionInitEvent) => {
    const sessionId = resolveSessionId(event);
    if (!sessionId) return;

    const context = await analyticsContextFor({
      ctx: event.ctx,
      extra: event.extra,
      headers: event.headers ?? event.extra?.requestInfo?.headers,
      authInfo: event.authInfo ?? event.extra?.authInfo,
    });

    const finishedAtMs = Date.now();
    const startedAt = normalizeStartedAt({
      startedAt: event.startedAt,
      finishedAtMs,
    });
    const batch = buildSessionInitBatch({
      actorId: context.actorId,
      sessionId,
      startedAt,
      extra: event.extra,
      sessionInitKeys,
      clientInfo:
        event.clientInfo
        ?? getClientInfoForSessionId(sessionId)
        ?? parseStatelessSessionClientInfo(sessionId),
      workflowRunId: resolveWorkflowRunId(event),
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

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const durationMs = event.durationMs ?? 0;
    const startedAt = normalizeStartedAt({
      startedAt: event.startedAt,
      durationMs,
      finishedAtMs,
    });
    const requestId = normalizeRequestId(event.requestId);
    const sessionId = resolveSessionId(event);
    const errorMessage = event.error === undefined
      ? undefined
      : event.error instanceof Error
        ? event.error.message
        : String(event.error);

    const workflowRunId = resolveWorkflowRunId(event);
    const toolCallEvent = buildToolCallEvent({
      toolName: event.name,
      telemetry: event.telemetry,
      input: event.args,
      output: event.result,
      status: event.status,
      durationMs,
      errorMessage,
      actorId: context.actorId,
      sessionId,
      requestId,
      startedAt,
      finishedAt,
      workflowRunId,
    });

    // An explicit clientInfo on the event always wins; otherwise look up
    // whatever the initialize-handshake patch captured for this sessionId; as a
    // last resort, identity-bearing session ids (stateless HTTP) are parseable.
    const effectiveClientInfo =
      event.clientInfo
      ?? getClientInfoForSessionId(sessionId)
      ?? parseStatelessSessionClientInfo(sessionId);

    await emitBatch(
      buildBatch({
        event: toolCallEvent,
        extra: {
          ...(event.extra ?? {}),
          ...(sessionId ? { sessionId } : {}),
        },
        actorId: context.actorId,
        startedAt,
        sessionInitKeys,
        clientInfo: effectiveClientInfo,
        workflowRunId,
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
      // A handler that returns an MCP error result (`isError: true`) instead of
      // throwing is still a failed call; record it as such while returning the
      // original result to the caller untouched.
      const resultError = deriveToolResultError(result);
      await recordToolCall({
        ...event,
        args,
        telemetry,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        ...(resultError === undefined
          ? { status: "ok" as const, result }
          : { status: "error" as const, result, error: resultError }),
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
        // Same nudge `decorateDefinitions` applies in the registry path — the
        // caller-owned McpServer path must also tell agents to pass
        // telemetry.intent, or sessions arrive with no intent (ARM-24).
        description: appendTelemetryHint(registration.description),
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
