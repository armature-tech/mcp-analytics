import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
};

export type ToolCallback = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

export type RegisterTool = (
  name: string,
  config: ToolConfig,
  cb: ToolCallback,
) => unknown;

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export type McpClientInfo = {
  name?: string;
  version?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown> | null;
};

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
  armature?: {
    endpointUrl?: string;
    apiKey?: string;
    actorId?: string | ActorIdResolver;
    enabled?: boolean;
    delivery?: "background" | "await";
    emit?: TelemetryEmitter;
    onError?: (error: unknown, batch: AnalyticsIngestBatch) => void;
    timeoutMs?: number;
  };
};

// Telemetry schema shape is Armature-owned. The strict-mode flag lives here so
// internal call sites (and tests) can opt into validation, but it is intentionally
// absent from the public `McpAnalyticsConfig` surface — customers should not be
// reaching into telemetry behavior.
export type InternalMcpAnalyticsConfig = McpAnalyticsConfig & {
  telemetry?: {
    intent?: "required" | "optional";
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
  clientInfo?: McpClientInfo;
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
  clientInfo?: McpClientInfo;
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
  clientInfo?: McpClientInfo;
};

export type ToolCallHandler<T> = (args: unknown) => T | Promise<T>;

export type ToolHandlerContext = {
  ctx?: unknown;
  extra?: RequestExtra;
  headers?: HeaderBag;
  authInfo?: RequestExtra["authInfo"];
  sessionId?: string;
  requestId?: string;
  clientInfo?: McpClientInfo;
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

export type WithMcpAnalyticsResult<ServerFactoryResult> = {
  result: ServerFactoryResult;
  recorder: AnalyticsRecorder;
};
