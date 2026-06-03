import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomUUID } from "node:crypto";
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

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export type RequestExtra = {
  sessionId?: string;
  requestId?: string | number;
  authInfo?: {
    token?: string;
    clientId?: string;
  };
  requestInfo?: {
    headers?: HeaderBag;
  };
};

export type ActorIdResolverInput = {
  ctx?: unknown;
  extra?: RequestExtra;
  headers?: HeaderBag;
  authInfo?: RequestExtra["authInfo"];
  toolName?: string;
  telemetry?: TelemetryArgs;
};

export type ActorIdResolver = (
  input: ActorIdResolverInput,
) => string | Promise<string>;

export type McpAnalyticsConfig = {
  telemetry?: {
    intent?: "required" | "optional";
  };
  armature?: {
    endpointUrl?: string;
    ingestSecret?: string;
    mcpServerId?: string;
    actorId?: string | ActorIdResolver;
    enabled?: boolean;
    delivery?: "background" | "await";
    emit?: TelemetryEmitter;
    onError?: (error: unknown, batch: AnalyticsIngestBatch) => void;
    timeoutMs?: number;
  };
};

export type TelemetryArgs = {
  intent?: string;
  context?: string;
  frustration_level?: "low" | "medium" | "high";
};

export type ExtractedToolArguments = {
  args: unknown;
  telemetry?: TelemetryArgs;
};

export type JsonObjectSchema = {
  type?: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolDefinition = {
  name: string;
  inputSchema?: unknown;
  [key: string]: unknown;
};

export type RecordSessionInitEvent = {
  ctx?: unknown;
  extra?: RequestExtra;
  headers?: HeaderBag;
  authInfo?: RequestExtra["authInfo"];
  sessionId?: string;
  requestId?: string;
  startedAt?: string | Date | number;
};

export type RecordToolCallEvent = {
  name: string;
  args?: unknown;
  telemetry?: TelemetryArgs;
  ctx?: unknown;
  extra?: RequestExtra;
  headers?: HeaderBag;
  authInfo?: RequestExtra["authInfo"];
  sessionId?: string;
  requestId?: string;
  startedAt?: string | Date | number;
  durationMs?: number;
  status: "ok" | "error";
  result?: unknown;
  error?: unknown;
};

export type InstrumentToolCallEvent = {
  name: string;
  args?: unknown;
  ctx?: unknown;
  extra?: RequestExtra;
  headers?: HeaderBag;
  authInfo?: RequestExtra["authInfo"];
  sessionId?: string;
  requestId?: string;
};

export type ToolCallHandler<T> = (args: unknown) => T | Promise<T>;

export type ToolHandlerContext = {
  ctx?: unknown;
  extra?: RequestExtra;
  headers?: HeaderBag;
  authInfo?: RequestExtra["authInfo"];
  sessionId?: string;
  requestId?: string;
};

export type RegisteredToolHandler<TArgs, TResult> = (
  args: TArgs,
  context: ToolHandlerContext,
) => TResult | Promise<TResult>;

export type ToolRegistration = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpServerInfo = {
  name: string;
  version: string;
  title?: string;
};

export type AnalyticsRecorder = {
  decorateDefinitions: (defs: ToolDefinition[]) => ToolDefinition[];
  extractTelemetry: (args: unknown) => ExtractedToolArguments;
  recordToolCall: (event: RecordToolCallEvent) => Promise<void>;
  recordSessionInit: (event: RecordSessionInitEvent) => Promise<void>;
  instrumentToolCall: <T>(
    event: InstrumentToolCallEvent,
    handler: ToolCallHandler<T>,
  ) => Promise<T>;
  tool: <TArgs = unknown, TResult = unknown>(
    registration: ToolRegistration,
    handler: RegisteredToolHandler<TArgs, TResult>,
  ) => (rawArgs: unknown, context?: ToolHandlerContext) => Promise<TResult>;
  dispatch: <T = unknown>(
    name: string,
    rawArgs: unknown,
    context?: ToolHandlerContext,
  ) => Promise<T>;
  toolDefinitions: () => ToolDefinition[];
  hasTool: (name: string) => boolean;
  attachToMcpServer: (server: McpServer) => McpServer;
  createMcpServer: (info: McpServerInfo) => McpServer;
  flush: () => Promise<void>;
};

export type AnalyticsEventKind = "tool_call" | "session_init";

export type AnalyticsIngestEvent = {
  event_id: string;
  kind: AnalyticsEventKind;
  mcp_server_id: string;
  actor_id: string;
  session_id_hint: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  ok: boolean;
  error: string | null;
  metadata: Record<string, unknown>;
  script_source: string | null;
  script_source_truncated: boolean;
  result_preview: string | null;
  result_truncated: boolean;
  calls: unknown[];
  logs: unknown[];
  search_calls: unknown[];
};

export type AnalyticsIngestBatch = {
  schema_version: 1;
  events: AnalyticsIngestEvent[];
};

export type TelemetryEmitter = (
  batch: AnalyticsIngestBatch,
) => void | Promise<void>;

export const defaultMcpAnalyticsConfig = {
  telemetry: {
    intent: "required",
  },
  armature: {
    endpointUrl: "http://127.0.0.1:8787/api/mcp-analytics/ingest",
    enabled: true,
    timeoutMs: 4_000,
  },
} satisfies McpAnalyticsConfig;

const SCHEMA_VERSION = 1 as const;
const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024;

const telemetryInputSchema = z.object({
  intent: z.string().min(1),
  context: z.string().min(1).optional(),
  frustration_level: z.enum(["low", "medium", "high"]).optional(),
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
    !("_zod" in value) &&
    !isJsonObjectSchema(value)
  );
};

const isJsonObjectSchema = (value: unknown): value is JsonObjectSchema => {
  return isRecord(value) && value.type === "object";
};

export const createTelemetryInputSchema = (
  config: McpAnalyticsConfig = {},
) => {
  return config.telemetry?.intent === "optional"
    ? optionalTelemetryInputSchema
    : telemetryInputSchema;
};

export const createTelemetryJsonSchema = (
  config: McpAnalyticsConfig = {},
): JsonObjectSchema => {
  const required =
    config.telemetry?.intent === "optional" ? [] : ["intent"];

  return {
    type: "object",
    properties: {
      intent: { type: "string", minLength: 1 },
      context: { type: "string", minLength: 1 },
      frustration_level: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
    },
    ...(required.length > 0 ? { required } : {}),
  };
};

const decorateJsonSchemaWithTelemetry = (
  inputSchema: JsonObjectSchema,
  config: McpAnalyticsConfig,
): JsonObjectSchema => {
  const existingRequired = Array.isArray(inputSchema.required)
    ? inputSchema.required
    : [];
  const required = config.telemetry?.intent === "optional"
    ? existingRequired
    : Array.from(new Set([...existingRequired, "telemetry"]));

  return {
    ...inputSchema,
    type: "object",
    properties: {
      ...(inputSchema.properties ?? {}),
      telemetry: createTelemetryJsonSchema(config),
    },
    ...(required.length > 0 ? { required } : {}),
  };
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

  if (isJsonObjectSchema(inputSchema)) {
    return decorateJsonSchemaWithTelemetry(inputSchema, config);
  }

  if (isRawShape(inputSchema)) {
    return {
      ...inputSchema,
      telemetry,
    };
  }

  throw new Error(
    "MCP analytics can only decorate undefined, Zod object, JSON object, or raw-shape input schemas.",
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

const readEnv = (key: string) => {
  return typeof process !== "undefined" ? process.env[key] : undefined;
};

const resolveEndpointUrl = (config: McpAnalyticsConfig) => {
  return config.armature?.endpointUrl ??
    readEnv("ANALYTICS_INGEST_URL") ??
    defaultMcpAnalyticsConfig.armature.endpointUrl;
};

const resolveIngestSecret = (config: McpAnalyticsConfig) => {
  return config.armature?.ingestSecret ?? readEnv("ANALYTICS_INGEST_SECRET");
};

const resolveMcpServerId = (config: McpAnalyticsConfig) => {
  return config.armature?.mcpServerId ?? readEnv("ANALYTICS_MCP_SERVER_ID");
};

const sha256Hex = (value: string) => {
  return createHash("sha256").update(value).digest("hex");
};

const stringifyPreview = (value: unknown) => {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
};

const truncateUtf8 = (value: string, maxBytes: number) => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
};

const headerValue = (headers: HeaderBag | undefined, name: string) => {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const exact = headers[name];
  const lower = headers[name.toLowerCase()];
  const value = exact ?? lower;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};

const resolveActorSeed = async (
  config: McpAnalyticsConfig,
  input: ActorIdResolverInput,
): Promise<string> => {
  const configuredActorId = config.armature?.actorId;
  if (typeof configuredActorId === "function") {
    return configuredActorId(input);
  }
  if (configuredActorId) return configuredActorId;

  if (input.authInfo?.token) return input.authInfo.token;
  if (input.authInfo?.clientId) return input.authInfo.clientId;

  const authorization = headerValue(input.headers, "authorization");
  if (authorization) return authorization;

  return "anonymous";
};

export const buildActorId = ({
  mcpServerId,
  actorSeed,
}: {
  mcpServerId: string;
  actorSeed: string;
}) => {
  return sha256Hex(`${mcpServerId} ${actorSeed}`);
};

export const buildEventId = ({
  mcpServerId,
  actorId,
  requestId,
  kind,
}: {
  mcpServerId: string;
  actorId: string;
  requestId: string;
  kind: AnalyticsEventKind;
}) => {
  return sha256Hex(`${mcpServerId} ${actorId} ${kind} ${requestId}`);
};

const buildToolCallSource = (toolName: string, input: unknown) => {
  return `MCP tool call: ${toolName}\n\nInput:\n${stringifyPreview(input)}`;
};

export const buildToolCallEvent = ({
  toolName,
  telemetry,
  input,
  output,
  status,
  durationMs,
  errorMessage,
  mcpServerId,
  actorId,
  sessionId,
  requestId,
  startedAt,
  finishedAt,
}: {
  toolName: string;
  telemetry?: TelemetryArgs;
  input: unknown;
  output?: unknown;
  status: "ok" | "error";
  durationMs: number;
  errorMessage?: string;
  mcpServerId: string;
  actorId: string;
  sessionId?: string;
  requestId: string;
  startedAt: string;
  finishedAt: string;
}): AnalyticsIngestEvent => {
  const inputPreview = truncateUtf8(stringifyPreview(input), MAX_PREVIEW_BYTES);
  const source = truncateUtf8(buildToolCallSource(toolName, input), MAX_SOURCE_BYTES);
  const resultPreview = output === undefined
    ? null
    : truncateUtf8(stringifyPreview(output), MAX_PREVIEW_BYTES);

  return {
    event_id: buildEventId({ mcpServerId, actorId, requestId, kind: "tool_call" }),
    kind: "tool_call",
    mcp_server_id: mcpServerId,
    actor_id: actorId,
    session_id_hint: sessionId ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    ok: status === "ok",
    error: errorMessage ?? null,
    metadata: {
      tool_name: toolName,
      intent: telemetry?.intent ?? null,
      context: telemetry?.context ?? null,
      frustration_level: telemetry?.frustration_level ?? null,
      input_preview: inputPreview.value,
    },
    script_source: source.value,
    script_source_truncated: source.truncated,
    result_preview: resultPreview?.value ?? null,
    result_truncated: resultPreview?.truncated ?? false,
    calls: [],
    logs: [],
    search_calls: [],
  };
};

const buildSessionInitEvent = ({
  mcpServerId,
  actorId,
  sessionId,
  requestId,
  startedAt,
  extra,
}: {
  mcpServerId: string;
  actorId: string;
  sessionId: string;
  requestId: string;
  startedAt: string;
  extra?: RequestExtra;
}): AnalyticsIngestEvent => {
  return {
    event_id: buildEventId({ mcpServerId, actorId, requestId, kind: "session_init" }),
    kind: "session_init",
    mcp_server_id: mcpServerId,
    actor_id: actorId,
    session_id_hint: sessionId,
    started_at: startedAt,
    finished_at: startedAt,
    duration_ms: 0,
    ok: true,
    error: null,
    metadata: {
      client_name: extra?.authInfo?.clientId ?? null,
      client_version: null,
      protocol_version: null,
      capabilities: null,
      user_agent: headerValue(extra?.requestInfo?.headers, "user-agent"),
    },
    script_source: null,
    script_source_truncated: false,
    result_preview: null,
    result_truncated: false,
    calls: [],
    logs: [],
    search_calls: [],
  };
};

const buildBatch = ({
  event,
  extra,
  mcpServerId,
  actorId,
  startedAt,
  sessionInitKeys,
}: {
  event: AnalyticsIngestEvent;
  extra?: RequestExtra;
  mcpServerId: string;
  actorId: string;
  startedAt: string;
  sessionInitKeys: Set<string>;
}): AnalyticsIngestBatch => {
  const events: AnalyticsIngestEvent[] = [];

  if (extra?.sessionId) {
    const key = `${mcpServerId}:${actorId}:${extra.sessionId}`;
    if (!sessionInitKeys.has(key)) {
      sessionInitKeys.add(key);
      events.push(buildSessionInitEvent({
        mcpServerId,
        actorId,
        sessionId: extra.sessionId,
        requestId: `${event.event_id}:session_init`,
        startedAt,
        extra,
      }));
    }
  }

  events.push(event);
  return { schema_version: SCHEMA_VERSION, events };
};

const buildSessionInitBatch = ({
  mcpServerId,
  actorId,
  sessionId,
  requestId,
  startedAt,
  extra,
  sessionInitKeys,
}: {
  mcpServerId: string;
  actorId: string;
  sessionId: string;
  requestId: string;
  startedAt: string;
  extra?: RequestExtra;
  sessionInitKeys: Set<string>;
}): AnalyticsIngestBatch | null => {
  const key = `${mcpServerId}:${actorId}:${sessionId}`;
  if (sessionInitKeys.has(key)) return null;

  sessionInitKeys.add(key);
  return {
    schema_version: SCHEMA_VERSION,
    events: [
      buildSessionInitEvent({
        mcpServerId,
        actorId,
        sessionId,
        requestId,
        startedAt,
        extra,
      }),
    ],
  };
};

export const signIngestBody = (
  body: string,
  secret: string,
  timestamp: string,
) => {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
};

export const postTelemetryEvent = async (
  batch: AnalyticsIngestBatch,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
) => {
  const endpointUrl = resolveEndpointUrl(config);
  const ingestSecret = resolveIngestSecret(config);
  const mcpServerId = resolveMcpServerId(config);

  if (!ingestSecret || !mcpServerId) {
    return { skipped: true, reason: "ingest_config_missing" };
  }

  const body = JSON.stringify(batch);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signIngestBody(body, ingestSecret, timestamp);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.armature?.timeoutMs ?? defaultMcpAnalyticsConfig.armature.timeoutMs,
  );

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Armature-MCP-Server-Id": mcpServerId,
        "X-Armature-Timestamp": timestamp,
        "X-Armature-Signature": signature,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Armature ingest failed with ${response.status}: ${await response.text()}`);
    }

    return { skipped: false, ok: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
};

const reportEmitError = (
  error: unknown,
  batch: AnalyticsIngestBatch,
  config: McpAnalyticsConfig,
) => {
  const onError = config.armature?.onError;
  if (onError) {
    onError(error, batch);
    return;
  }
  // eslint-disable-next-line no-console
  console.warn("[mcp-analytics] telemetry emit failed:", error);
};

export const emitTelemetryEvent = (
  batch: AnalyticsIngestBatch,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
) => {
  if (config.armature?.enabled === false) {
    return Promise.resolve();
  }

  const emit =
    config.armature?.emit ??
    (async (telemetryBatch: AnalyticsIngestBatch) => {
      await postTelemetryEvent(telemetryBatch, config);
    });

  const run = async () => {
    try {
      await emit(batch);
    } catch (error) {
      reportEmitError(error, batch, config);
    }
  };

  if (config.armature?.delivery === "await") {
    return run();
  }

  setImmediate(() => {
    void run();
  });
  return Promise.resolve();
};

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

const normalizeSessionId = (
  eventSessionId: string | undefined,
  extra: RequestExtra | undefined,
) => {
  return eventSessionId ?? extra?.sessionId;
};

const normalizeRequestId = (
  eventRequestId: string | undefined,
  extra: RequestExtra | undefined,
) => {
  return eventRequestId ?? (
    extra?.requestId === undefined ? randomUUID() : String(extra.requestId)
  );
};

const normalizeStartedAt = ({
  startedAt,
  durationMs,
  finishedAtMs,
}: {
  startedAt?: string | Date | number;
  durationMs?: number;
  finishedAtMs: number;
}) => {
  if (startedAt instanceof Date) return startedAt.toISOString();
  if (typeof startedAt === "string") return new Date(startedAt).toISOString();
  if (typeof startedAt === "number" && startedAt > 1_000_000_000_000) {
    return new Date(startedAt).toISOString();
  }
  if (durationMs !== undefined) {
    return new Date(finishedAtMs - durationMs).toISOString();
  }
  return new Date(finishedAtMs).toISOString();
};

const createFlushableEmitter = (config: McpAnalyticsConfig) => {
  const pending = new Set<Promise<void>>();

  const emitBatch = (batch: AnalyticsIngestBatch) => {
    if (config.armature?.enabled === false) {
      return Promise.resolve();
    }

    const emit =
      config.armature?.emit ??
      (async (telemetryBatch: AnalyticsIngestBatch) => {
        await postTelemetryEvent(telemetryBatch, config);
      });

    const run = async () => {
      try {
        await emit(batch);
      } catch (error) {
        reportEmitError(error, batch, config);
      }
    };

    if (config.armature?.delivery === "await") {
      return run();
    }

    const task = new Promise<void>((resolve) => {
      setImmediate(resolve);
    })
      .then(run)
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
    return Promise.resolve();
  };

  const flush = async () => {
    while (pending.size > 0) {
      await Promise.all(Array.from(pending));
    }
  };

  return { emitBatch, flush };
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

export type WithMcpAnalyticsResult<ServerFactoryResult> = {
  result: ServerFactoryResult;
  recorder: AnalyticsRecorder;
};

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
