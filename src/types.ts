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
    apiKey?: string;
    principalId?: string;
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

export type ActorIdentifierResolver = (
  input: ActorIdResolverInput,
) => string | Promise<string>;

// Applied to sanitized tool inputs/outputs (and the normalized telemetry
// object and error strings) before they are serialized into event previews.
// Must return the value to serialize; a throw fails closed (the affected
// payload is replaced with "[redaction failed]", the event still ships).
export type RedactFunction = (value: unknown) => unknown;

export type RedactableToolCall = {
  kind: "tool_call";
  toolName: string;
  status: "ok" | "error";
  durationMs: number;
  sessionId?: string;
  input: unknown;
  output?: unknown;
  errorMessage?: string;
  telemetry?: TelemetryArgs;
};

export type RedactEventHook = (
  event: RedactableToolCall,
) => RedactableToolCall | null | Promise<RedactableToolCall | null>;

// Opt-in export of customer-owned argument fields as Armature telemetry
// (gap #11). Keys are the V1 telemetry field names; values are top-level
// argument property names to READ (never strip) from the tool's arguments.
// An explicit `telemetry` value for the same field wins over the mapping.
export type TelemetryFieldMap = {
  /** @deprecated `user_turn` is no longer collected; this mapping is ignored. */
  user_turn?: string;
  user_intent?: string;
  agent_thinking?: string;
  user_frustration?: string;
};

export type McpAnalyticsConfig = {
  armature?: {
    endpointUrl?: string;
    apiKey?: string;
    actorId?: string | ActorIdResolver;
    /** Optional caller-provided identifier stored verbatim. */
    actorIdentifier?: string | ActorIdentifierResolver;
    enabled?: boolean;
    delivery?: "background" | "await";
    emit?: TelemetryEmitter;
    onError?: (error: unknown, batch: AnalyticsIngestBatch) => void;
    timeoutMs?: number;
    // Master switch for conversation-derived telemetry (user_intent,
    // agent_thinking, user_frustration). Default true. When false
    // the SDK injects no `telemetry` schema field, appends no description
    // nudges, and never exports telemetry values — including values sent by
    // clients holding a cached schema, which are stripped and dropped.
    captureTelemetry?: boolean;
    /** Built-in high-confidence secret detection. Enabled by default. */
    redactSecrets?: boolean;
    /** @deprecated Prefer redactEvent for event context and async support. */
    redact?: RedactFunction;
    redactEvent?: RedactEventHook;
    /** Register background work with a platform lifecycle primitive (for example waitUntil). */
    schedule?: (work: Promise<void>) => void;
    telemetryFieldMap?: TelemetryFieldMap;
    // SDK-owned request_capability tool that lets agents report a capability
    // absent from the server's current tool set. On by default (when a
    // delivery path is configured); set to false to disable.
    requestCapability?: boolean;
  };
};

// How an instrumented tool handles the `telemetry` argument field. Resolved
// once per tool at registration (see planToolTelemetry): `injected` — we added
// the field, so strip it from args and export it; `owned` — the customer's
// schema declares it, so never touch args and never export; `scrub` — capture
// is off, so strip a cached-schema client's telemetry but export nothing.
export type TelemetryMode = "injected" | "owned" | "scrub";

// Telemetry schema shape is Armature-owned. The former strict-mode config is
// retained only so existing source continues to compile; sparse intent makes
// required-per-call validation invalid.
export type InternalMcpAnalyticsConfig = McpAnalyticsConfig & {
  /** @deprecated Required-per-call intent conflicts with sparse intent declarations and is ignored. */
  telemetry?: {
    user_intent?: "required" | "optional";
    /** @deprecated Pre-V1 spelling retained for source compatibility; ignored. */
    intent?: "required" | "optional";
  };
};

// V1 telemetry field names. The pre-V1 spellings remain accepted on input
// (clients holding a cached pre-V1 tool schema, callers passing telemetry
// straight into recordToolCall) and are normalized onto the V1 names by
// normalizeTelemetryArgs before any event is built.
export type TelemetryArgs = {
  /** @deprecated `user_turn` is accepted from cached clients but ignored. */
  user_turn?: number;
  user_intent?: string;
  agent_thinking?: string;
  user_frustration?: "low" | "medium" | "high";
  /** @deprecated Pre-V1 spelling of `user_intent`; still accepted. */
  intent?: string;
  /** @deprecated Pre-V1 spelling of `agent_thinking`; still accepted. */
  context?: string;
  /** @deprecated Pre-V1 spelling of `user_frustration`; still accepted. */
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
  // Explicit workflow-run marker; when absent it is derived from the
  // x-armature-workflow-run-id request header. See workflowRunIdFromHeaders.
  workflowRunId?: string;
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
  workflowRunId?: string;
  // Internal provenance marker for the SDK-owned request_capability tool.
  capabilityRequest?: boolean;
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
  workflowRunId?: string;
  // Resolved telemetry mode for this tool (see TelemetryMode). Defaults to
  // "injected" — integrations that decorate schemas themselves (Mastra, the
  // prototype patch) pass the mode their planToolTelemetry call resolved.
  telemetryMode?: TelemetryMode;
  capabilityRequest?: boolean;
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
  workflowRunId?: string;
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
  outputSchema?: unknown;
  annotations?: unknown;
};

export type McpServerInfo = {
  name: string;
  version: string;
  title?: string;
};

export type AnalyticsRecorder = {
  decorateDefinitions: (defs: ToolDefinition[]) => ToolDefinition[];
  extractTelemetry: (
    args: unknown,
    mode?: TelemetryMode,
  ) => ExtractedToolArguments;
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

export type AnalyticsEventKind = "tool_call" | "session_init" | "actor_identity";

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
  // Present (true + the run uuid) only on telemetry produced by an Armature
  // workflow run; Session Analytics excludes such events and their sessions.
  is_workflow?: boolean;
  workflow_run_id?: string;
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
