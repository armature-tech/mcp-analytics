import { randomUUID } from "node:crypto";
import type {
  AnalyticsEventKind,
  AnalyticsIngestBatch,
  AnalyticsIngestEvent,
  RequestExtra,
  TelemetryArgs,
} from "./types.js";
import {
  MAX_PREVIEW_BYTES,
  MAX_SOURCE_BYTES,
  SCHEMA_VERSION,
  headerValue,
  sha256Hex,
  stringifyPreview,
  truncateUtf8,
} from "./utils.js";

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

export const buildSessionInitEvent = ({
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

export const buildBatch = ({
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

export const buildSessionInitBatch = ({
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

export const normalizeSessionId = (
  eventSessionId: string | undefined,
  extra: RequestExtra | undefined,
) => {
  return eventSessionId ?? extra?.sessionId;
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
