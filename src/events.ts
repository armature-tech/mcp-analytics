import { randomUUID } from "node:crypto";
import type {
  AnalyticsEventKind,
  AnalyticsIngestBatch,
  AnalyticsIngestEvent,
  McpClientInfo,
  RequestExtra,
  TelemetryArgs,
} from "./types.js";
import {
  MAX_CAPABILITIES_BYTES,
  MAX_PREVIEW_BYTES,
  MAX_SOURCE_BYTES,
  SCHEMA_VERSION,
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
    event_id: buildEventId({ actorId, requestId, kind: "tool_call" }),
    kind: "tool_call",
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

export const buildSessionInitEvent = ({
  actorId,
  sessionId,
  requestId,
  startedAt,
  extra,
  clientInfo,
}: {
  actorId: string;
  sessionId: string;
  requestId: string;
  startedAt: string;
  extra?: RequestExtra;
  clientInfo?: McpClientInfo;
}): AnalyticsIngestEvent => {
  return {
    event_id: buildEventId({ actorId, requestId, kind: "session_init" }),
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
  extra,
  actorId,
  startedAt,
  sessionInitKeys,
  clientInfo,
}: {
  event: AnalyticsIngestEvent;
  extra?: RequestExtra;
  actorId: string;
  startedAt: string;
  sessionInitKeys: Set<string>;
  clientInfo?: McpClientInfo;
}): AnalyticsIngestBatch => {
  const events: AnalyticsIngestEvent[] = [];

  if (extra?.sessionId) {
    const key = `${actorId}:${extra.sessionId}`;
    if (!sessionInitKeys.has(key)) {
      sessionInitKeys.add(key);
      events.push(buildSessionInitEvent({
        actorId,
        sessionId: extra.sessionId,
        requestId: `${event.event_id}:session_init`,
        startedAt,
        extra,
        clientInfo,
      }));
    }
  }

  events.push(event);
  return { schema_version: SCHEMA_VERSION, events };
};

export const buildSessionInitBatch = ({
  actorId,
  sessionId,
  requestId,
  startedAt,
  extra,
  sessionInitKeys,
  clientInfo,
}: {
  actorId: string;
  sessionId: string;
  requestId: string;
  startedAt: string;
  extra?: RequestExtra;
  sessionInitKeys: Set<string>;
  clientInfo?: McpClientInfo;
}): AnalyticsIngestBatch | null => {
  const key = `${actorId}:${sessionId}`;
  if (sessionInitKeys.has(key)) return null;

  sessionInitKeys.add(key);
  return {
    schema_version: SCHEMA_VERSION,
    events: [
      buildSessionInitEvent({
        actorId,
        sessionId,
        requestId,
        startedAt,
        extra,
        clientInfo,
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

export const normalizeRequestId = (
  eventRequestId: string | undefined,
  extra: RequestExtra | undefined,
) => {
  return eventRequestId ?? (
    extra?.requestId === undefined ? randomUUID() : String(extra.requestId)
  );
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
