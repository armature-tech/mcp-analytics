import { randomUUID } from "node:crypto";
import { normalizeTelemetryArgs } from "./schema.js";
import {
  prepareForPreview,
  REDACTION_FAILED_PLACEHOLDER,
} from "./sanitize.js";
import { redactSecretsInString } from "./redact-secrets.js";
import type {
  AnalyticsEventKind,
  AnalyticsIngestBatch,
  AnalyticsIngestEvent,
  McpClientInfo,
  RedactableToolCall,
  RedactEventHook,
  RedactFunction,
  RequestExtra,
  TelemetryArgs,
} from "./types.js";
import {
  MAX_CAPABILITIES_BYTES,
  MAX_PREVIEW_BYTES,
  MAX_SOURCE_BYTES,
  SCHEMA_VERSION,
  type BoundedKeySet,
  headerValue,
  isRecord,
  sha256Hex,
  stringifyPreview,
  truncateUtf8,
} from "./utils.js";

const trimOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const capCapabilities = (
  capabilities: McpClientInfo["capabilities"],
): Record<string, unknown> | null => {
  if (!isRecord(capabilities)) return null;
  try {
    if (JSON.stringify(capabilities).length > MAX_CAPABILITIES_BYTES) return null;
  } catch {
    return null;
  }
  return capabilities;
};

export const buildActorId = ({
  actorSeed,
}: {
  actorSeed: string;
}) => {
  return sha256Hex(actorSeed);
};

export const buildEventId = ({
  actorId,
  requestId,
  kind,
}: {
  actorId: string;
  requestId: string;
  kind: AnalyticsEventKind;
}) => {
  return sha256Hex(`${actorId} ${kind} ${requestId}`);
};

export const buildActorIdentityEvent = ({
  actorId,
  identifier,
  startedAt,
}: {
  actorId: string;
  identifier: string;
  startedAt: string;
}): AnalyticsIngestEvent => {
  return {
    event_id: buildEventId({ actorId, requestId: identifier, kind: "actor_identity" }),
    kind: "actor_identity",
    actor_id: actorId,
    session_id_hint: null,
    started_at: startedAt,
    finished_at: startedAt,
    duration_ms: 0,
    ok: true,
    error: null,
    metadata: { identifier },
    script_source: null,
    script_source_truncated: false,
    result_preview: null,
    result_truncated: false,
    calls: [],
    logs: [],
    search_calls: [],
  };
};

const buildToolCallSource = (toolName: string, input: unknown) => {
  return `MCP tool call: ${toolName}\n\nInput:\n${stringifyPreview(input)}`;
};

// Telemetry text values get the same treatment as tool inputs/outputs:
// base64/binary sanitization (always) plus built-in secret redaction (when
// enabled). Previously these fields only saw redactSecretsInString, so a
// whole-value or embedded ≥512-char base64 blob reached the ingest body
// verbatim (#1393). The legacy `redact` hook still runs once over the whole
// telemetry object in prepareTelemetry, so it is not passed here.
const sanitizeTelemetryText = (value: string, redactSecrets: boolean): string => {
  const prepared = prepareForPreview(value, undefined, { redactSecrets });
  return typeof prepared === "string" ? prepared : stringifyPreview(prepared);
};

const prepareTelemetry = (
  telemetry: TelemetryArgs | undefined,
  redact: RedactFunction | undefined,
  redactSecrets: boolean,
): TelemetryArgs | undefined => {
  const normalized = normalizeTelemetryArgs(telemetry);
  if (!normalized) return undefined;
  const protectedTelemetry: TelemetryArgs = {
    ...normalized,
    ...(typeof normalized.user_intent === "string"
      ? { user_intent: sanitizeTelemetryText(normalized.user_intent, redactSecrets) }
      : {}),
    ...(typeof normalized.agent_thinking === "string"
      ? { agent_thinking: sanitizeTelemetryText(normalized.agent_thinking, redactSecrets) }
      : {}),
  };
  if (!redact) return protectedTelemetry;
  try {
    return normalizeTelemetryArgs(redact(protectedTelemetry) as TelemetryArgs);
  } catch {
    return undefined;
  }
};

const prepareErrorMessage = (
  errorMessage: string | undefined,
  redact: RedactFunction | undefined,
  redactSecrets: boolean,
): string | undefined => {
  if (errorMessage === undefined) return undefined;
  const protectedMessage = redactSecrets
    ? redactSecretsInString(errorMessage)
    : errorMessage;
  if (!redact) return protectedMessage;
  try {
    const redacted = redact(protectedMessage);
    return typeof redacted === "string" ? redacted : stringifyPreview(redacted);
  } catch {
    return REDACTION_FAILED_PLACEHOLDER;
  }
};

export type BuildToolCallEventInput = {
  toolName: string;
  telemetry?: TelemetryArgs;
  input: unknown;
  output?: unknown;
  status: "ok" | "error";
  durationMs: number;
  errorMessage?: string;
  actorId: string;
  sessionId?: string;
  requestId: string;
  startedAt: string;
  finishedAt: string;
  workflowRunId?: string;
  capabilityRequest?: boolean;
  redact?: RedactFunction;
  redactSecrets?: boolean;
};

const prepareToolCallCandidate = ({
  toolName,
  telemetry,
  input,
  output,
  status,
  durationMs,
  errorMessage,
  sessionId,
  redact,
  redactSecrets = true,
}: BuildToolCallEventInput): RedactableToolCall => {
  const preparedTelemetry = prepareTelemetry(telemetry, redact, redactSecrets);
  return {
    kind: "tool_call",
    toolName,
    status,
    durationMs,
    ...(sessionId ? { sessionId } : {}),
    input: prepareForPreview(input, redact, { redactSecrets }),
    ...(output === undefined
      ? {}
      : { output: prepareForPreview(output, redact, { redactSecrets }) }),
    ...(errorMessage === undefined
      ? {}
      : { errorMessage: prepareErrorMessage(errorMessage, redact, redactSecrets) }),
    ...(preparedTelemetry === undefined ? {} : { telemetry: preparedTelemetry }),
  };
};

// Marks an event as synthetic traffic from an Armature workflow run so
// Session Analytics can exclude it. Spread first in the event literal —
// absent when the call did not originate from a workflow run.
const workflowStamp = (
  workflowRunId: string | undefined,
): Pick<AnalyticsIngestEvent, "is_workflow" | "workflow_run_id"> | Record<string, never> => {
  if (!workflowRunId) return {};
  return { is_workflow: true, workflow_run_id: workflowRunId };
};

const assembleToolCallEvent = (
  candidate: RedactableToolCall,
  input: BuildToolCallEventInput,
): AnalyticsIngestEvent => {
  const inputPreview = truncateUtf8(stringifyPreview(candidate.input), MAX_PREVIEW_BYTES);
  const source = truncateUtf8(
    buildToolCallSource(candidate.toolName, candidate.input),
    MAX_SOURCE_BYTES,
  );
  const resultPreview = candidate.output === undefined
    ? null
    : truncateUtf8(stringifyPreview(candidate.output), MAX_PREVIEW_BYTES);
  const t = normalizeTelemetryArgs(candidate.telemetry);

  return {
    ...workflowStamp(input.workflowRunId),
    event_id: buildEventId({ actorId: input.actorId, requestId: input.requestId, kind: "tool_call" }),
    kind: "tool_call",
    actor_id: input.actorId,
    session_id_hint: candidate.sessionId ?? null,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    duration_ms: candidate.durationMs,
    ok: candidate.status === "ok",
    error: candidate.errorMessage ?? null,
    metadata: {
      tool_name: candidate.toolName,
      user_intent: t?.user_intent ?? null,
      agent_thinking: t?.agent_thinking ?? null,
      user_frustration: t?.user_frustration ?? null,
      // Legacy mirrors (pre-V1 key names) so an ingest that hasn't picked up
      // the V1 schema keeps reading events from this SDK.
      intent: t?.user_intent ?? null,
      context: t?.agent_thinking ?? null,
      frustration_level: t?.user_frustration ?? null,
      input_preview: inputPreview.value,
      ...(input.capabilityRequest ? { capability_request: true } : {}),
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

export const buildToolCallEvent = (
  input: BuildToolCallEventInput,
): AnalyticsIngestEvent => {
  return assembleToolCallEvent(prepareToolCallCandidate(input), input);
};

export const finalizeToolCallEvent = async (
  input: BuildToolCallEventInput & { redactEvent?: RedactEventHook },
): Promise<AnalyticsIngestEvent | null> => {
  let candidate = prepareToolCallCandidate(input);
  if (input.redactEvent) {
    try {
      const redacted = await input.redactEvent(candidate);
      if (redacted === null) return null;
      candidate = redacted;
    } catch {
      candidate = {
        ...candidate,
        input: REDACTION_FAILED_PLACEHOLDER,
        output: REDACTION_FAILED_PLACEHOLDER,
        errorMessage: REDACTION_FAILED_PLACEHOLDER,
        telemetry: undefined,
      };
    }
  }
  return assembleToolCallEvent(candidate, input);
};

export const buildSessionInitEvent = ({
  actorId,
  sessionId,
  startedAt,
  extra,
  clientInfo,
  workflowRunId,
}: {
  actorId: string;
  sessionId: string;
  startedAt: string;
  extra?: RequestExtra;
  clientInfo?: McpClientInfo;
  workflowRunId?: string;
}): AnalyticsIngestEvent => {
  return {
    ...workflowStamp(workflowRunId),
    // Stable per (actorId, sessionId): a session has exactly one session_init,
    // so seeding the id with the sessionId lets ingest de-dup it on its own —
    // independent of the in-memory `sessionInitKeys` set (which is now bounded
    // and may evict) and idempotent across process restarts / serverless cold
    // starts that re-handle the same session. `kind` is already in the hash, so
    // there's no collision with tool_call ids that reuse the same seed.
    event_id: buildEventId({ actorId, requestId: sessionId, kind: "session_init" }),
    kind: "session_init",
    actor_id: actorId,
    session_id_hint: sessionId,
    started_at: startedAt,
    finished_at: startedAt,
    duration_ms: 0,
    ok: true,
    error: null,
    metadata: {
      client_name:
        trimOrUndefined(clientInfo?.name)
        ?? trimOrUndefined(extra?.authInfo?.clientId)
        ?? trimOrUndefined(headerValue(extra?.requestInfo?.headers, "x-mcp-client"))
        ?? null,
      client_version: trimOrUndefined(clientInfo?.version) ?? null,
      protocol_version: trimOrUndefined(clientInfo?.protocolVersion) ?? null,
      capabilities: capCapabilities(clientInfo?.capabilities),
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

export const buildBatch = ({
  event,
  identityEvent,
  extra,
  actorId,
  startedAt,
  sessionInitKeys,
  clientInfo,
  workflowRunId,
}: {
  event: AnalyticsIngestEvent;
  identityEvent?: AnalyticsIngestEvent;
  extra?: RequestExtra;
  actorId: string;
  startedAt: string;
  sessionInitKeys: BoundedKeySet;
  clientInfo?: McpClientInfo;
  workflowRunId?: string;
}): AnalyticsIngestBatch => {
  const events: AnalyticsIngestEvent[] = [];

  if (identityEvent) events.push(identityEvent);

  if (extra?.sessionId) {
    const key = `${actorId}:${extra.sessionId}`;
    if (!sessionInitKeys.has(key)) {
      sessionInitKeys.add(key);
      events.push(buildSessionInitEvent({
        actorId,
        sessionId: extra.sessionId,
        startedAt,
        extra,
        clientInfo,
        workflowRunId,
      }));
    }
  }

  events.push(event);
  return { schema_version: SCHEMA_VERSION, events };
};

export const buildSessionInitBatch = ({
  actorId,
  sessionId,
  startedAt,
  extra,
  sessionInitKeys,
  clientInfo,
  workflowRunId,
  identityEvent,
}: {
  actorId: string;
  sessionId: string;
  startedAt: string;
  extra?: RequestExtra;
  sessionInitKeys: BoundedKeySet;
  clientInfo?: McpClientInfo;
  workflowRunId?: string;
  identityEvent?: AnalyticsIngestEvent;
}): AnalyticsIngestBatch | null => {
  const key = `${actorId}:${sessionId}`;
  if (sessionInitKeys.has(key)) {
    return identityEvent
      ? { schema_version: SCHEMA_VERSION, events: [identityEvent] }
      : null;
  }

  sessionInitKeys.add(key);
  return {
    schema_version: SCHEMA_VERSION,
    events: [
      ...(identityEvent ? [identityEvent] : []),
      buildSessionInitEvent({
        actorId,
        sessionId,
        startedAt,
        extra,
        clientInfo,
        workflowRunId,
      }),
    ],
  };
};

export const normalizeSessionId = (
  eventSessionId: string | undefined,
  extra: RequestExtra | undefined,
): string | undefined => {
  const explicit = trimOrUndefined(eventSessionId) ?? trimOrUndefined(extra?.sessionId);
  if (explicit) return explicit;
  return trimOrUndefined(headerValue(extra?.requestInfo?.headers, "mcp-session-id"));
};

// The analytics request id seeds `event_id` (see `buildEventId`), so it MUST be
// unique per tool-call invocation. We intentionally do NOT derive it from the
// MCP JSON-RPC request id (`extra.requestId`): that is an in-memory per-client
// counter (0, 1, 2, …) that restarts on reconnect, across stateless gateway
// instances, etc., so two unrelated tool calls routinely share `extra.requestId`
// and would collide on `event_id` — making ingest dedupe the second call away.
// An explicit caller-supplied id still wins (it's a deliberate idempotency key);
// otherwise we mint a fresh uuid, matching the prototype-patch path in server.ts.
export const normalizeRequestId = (eventRequestId: string | undefined) => {
  return eventRequestId ?? randomUUID();
};

export const normalizeStartedAt = ({
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
