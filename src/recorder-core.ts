import type {
  ActorIdResolverInput,
  ExtractedToolArguments,
  HeaderBag,
  InstrumentToolCallEvent,
  McpAnalyticsConfig,
  McpClientInfo,
  RecordSessionInitEvent,
  RecordToolCallEvent,
  RequestExtra,
  TelemetryMode,
  ToolCallHandler,
} from "./types.js";
import {
  buildActorId,
  buildActorIdentityEvent,
  buildBatch,
  buildSessionInitBatch,
  finalizeToolCallEvent,
  normalizeRequestId,
  normalizeSessionId,
  normalizeStartedAt,
} from "./events.js";
import {
  defaultMcpAnalyticsConfig,
  resolveActorSeed,
  resolveActorIdentifier,
} from "./emit.js";
import {
  applyTelemetryFieldMap,
  extractTelemetryArguments,
  isCaptureEnabled,
} from "./schema.js";
import {
  createBoundedKeySet,
  deriveToolResultError,
  headerValue,
  workflowRunIdFromHeaders,
} from "./utils.js";
import { processScopedSessionId } from "./stdio-session.js";
import { parseStatelessSessionClientInfo } from "./stateless-http.js";
import { createPrivacyQueue } from "./queue.js";

// The transport-independent record pipeline shared by the v1 recorder
// (recorder.ts) and the v2 adapter (v2.ts). Everything here is pure of
// `@modelcontextprotocol/*` runtime imports so the `/v2` subpath never loads
// the v1 SDK; v1-specific behavior (the `Server.prototype._onrequest` client
// info cache, the tool registry's telemetry-ownership map) is injected through
// `RecorderCoreHooks` by recorder.ts instead of imported here.

export type RecorderCoreHooks = {
  /**
   * Session-scoped client identity lookup consulted when an event carries no
   * explicit clientInfo. The v1 recorder wires the `_onrequest`-patch cache
   * here; the v2 adapter passes clientInfo per event (per-request envelope)
   * and needs no hook. The identity-bearing stateless session id parse runs
   * as a built-in last resort either way.
   */
  clientInfoForSessionId?: (sessionId: string) => McpClientInfo | undefined;
  /**
   * True when the named tool owns its `telemetry` input field (mode "owned",
   * TELEMETRY-CONTRACT.md): supplied telemetry must never be exported.
   */
  isToolTelemetryOwned?: (name: string) => boolean;
};

export type AnalyticsRecorderCore = {
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
  flush: () => Promise<void>;
};

const createAnalyticsContext = async (
  config: McpAnalyticsConfig,
  input: ActorIdResolverInput,
): Promise<{ actorId: string; actorIdentifier?: string }> => {
  const actorIdentifier = await resolveActorIdentifier(config, input);
  const actorSeed = actorIdentifier ?? await resolveActorSeed(config, input);
  return { actorId: buildActorId({ actorSeed }), actorIdentifier };
};

export const createAnalyticsRecorderCore = (
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
  hooks: RecorderCoreHooks = {},
): AnalyticsRecorderCore => {
  const privacyQueue = createPrivacyQueue(config);
  const flush = privacyQueue.flush;
  // Tracks which (actorId, sessionId) pairs have already emitted a session_init,
  // so we emit it at most once per session. Bounded with FIFO eviction: MCP
  // gives no reliable session-closed signal, so an unbounded set would leak on
  // long-running servers with high session churn. Eviction is safe because the
  // session_init event_id is stable per (actorId, sessionId), so a re-emit
  // after eviction collapses to the same id at ingest. 10k × ~60 bytes ≈ 600KB.
  const sessionInitKeys = createBoundedKeySet(10_000);
  // Per-process change detection. Event ids are content-addressed, so an
  // identical re-emit after restart is harmless and converges at ingest.
  const actorIdentifiers = new Map<string, string>();
  const identityEventFor = (
    context: Awaited<ReturnType<typeof createAnalyticsContext>>,
    startedAt: string,
  ) => {
    if (context.actorIdentifier === undefined) return undefined;
    if (actorIdentifiers.get(context.actorId) === context.actorIdentifier) return undefined;
    actorIdentifiers.set(context.actorId, context.actorIdentifier);
    if (actorIdentifiers.size > 10_000) {
      const oldest = actorIdentifiers.keys().next().value;
      if (oldest !== undefined) actorIdentifiers.delete(oldest);
    }
    return buildActorIdentityEvent({
      actorId: context.actorId,
      identifier: context.actorIdentifier,
      startedAt,
    });
  };

  const analyticsContextFor = async (input: ActorIdResolverInput) => {
    return createAnalyticsContext(config, input);
  };

  const resolveClientInfo = (
    explicit: McpClientInfo | undefined,
    sessionId: string | undefined,
  ): McpClientInfo | undefined => {
    if (explicit) return explicit;
    if (!sessionId) return undefined;
    return hooks.clientInfoForSessionId?.(sessionId)
      ?? parseStatelessSessionClientInfo(sessionId);
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
    const finishedAtMs = Date.now();
    const startedAt = normalizeStartedAt({
      startedAt: event.startedAt,
      finishedAtMs,
    });
    const workflowRunId = resolveWorkflowRunId(event);
    return privacyQueue.enqueue(async () => {
      const context = await analyticsContextFor({
        ctx: event.ctx,
        extra: event.extra,
        headers: event.headers ?? event.extra?.requestInfo?.headers,
        authInfo: event.authInfo ?? event.extra?.authInfo,
      });
      const batch = buildSessionInitBatch({
        actorId: context.actorId,
        sessionId,
        startedAt,
        extra: event.extra,
        sessionInitKeys,
        clientInfo: resolveClientInfo(event.clientInfo, sessionId),
        workflowRunId,
        identityEvent: identityEventFor(context, startedAt),
      });
      return batch?.events ?? null;
    });
  };

  const recordToolCall = async (event: RecordToolCallEvent) => {
    // Single choke point for capture-off and field ownership
    // (TELEMETRY-CONTRACT.md): telemetry handed in by any path — extraction,
    // direct recordToolCall callers, a cached-schema client — is dropped here
    // before it can reach the actor resolver, the event builder, `emit`, or
    // `onError`. A registered tool that owns its telemetry field never exports
    // supplied telemetry either; the opt-in field map is the explicit way to
    // export customer fields, and it only applies while capture is on.
    const ownedTool = hooks.isToolTelemetryOwned?.(event.name) === true;
    const telemetry = isCaptureEnabled(config)
      ? applyTelemetryFieldMap(
          ownedTool ? undefined : event.telemetry,
          event.args,
          config.armature?.telemetryFieldMap,
        )
      : undefined;

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const durationMs = event.durationMs ?? 0;
    const startedAt = normalizeStartedAt({
      startedAt: event.startedAt,
      durationMs,
      finishedAtMs,
    });
    const sessionId = resolveSessionId(event);
    const requestId = normalizeRequestId(event.requestId, sessionId);
    const errorMessage = event.error === undefined
      ? undefined
      : event.error instanceof Error
        ? event.error.message
        : String(event.error);

    const workflowRunId = resolveWorkflowRunId(event);
    return privacyQueue.enqueue(async () => {
      const context = await analyticsContextFor({
        ctx: event.ctx,
        extra: event.extra,
        headers: event.headers ?? event.extra?.requestInfo?.headers,
        authInfo: event.authInfo ?? event.extra?.authInfo,
        toolName: event.name,
        telemetry,
      });
      const toolCallEvent = await finalizeToolCallEvent({
        toolName: event.name,
        telemetry,
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
        capabilityRequest: event.capabilityRequest,
        metadataExtra: event.metadataExtra,
        redact: config.armature?.redact,
        redactSecrets: config.armature?.redactSecrets,
        redactEvent: config.armature?.redactEvent,
      });

      const effectiveClientInfo = resolveClientInfo(event.clientInfo, sessionId);
      const identityEvent = identityEventFor(context, startedAt);
      const extra = {
        ...(event.extra ?? {}),
        ...(sessionId ? { sessionId } : {}),
      };

      if (toolCallEvent) {
        return buildBatch({
          event: toolCallEvent,
          extra,
          actorId: context.actorId,
          startedAt,
          sessionInitKeys,
          clientInfo: effectiveClientInfo,
          workflowRunId,
          identityEvent,
        }).events;
      }

      if (sessionId) {
        return buildSessionInitBatch({
          actorId: context.actorId,
          sessionId,
          startedAt,
          extra,
          sessionInitKeys,
          clientInfo: effectiveClientInfo,
          workflowRunId,
          identityEvent,
        })?.events ?? null;
      }
      return identityEvent ? [identityEvent] : null;
    });
  };

  const instrumentToolCall = async <T>(
    event: InstrumentToolCallEvent,
    handler: ToolCallHandler<T>,
  ): Promise<T> => {
    const { args, telemetry } = extractTelemetryArguments(
      event.args,
      event.telemetryMode ?? "injected",
    );
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    try {
      const result = await handler(args);
      // A handler that returns an MCP error result (`isError: true`) instead of
      // throwing is still a failed call; record it as such while returning the
      // original result to the caller untouched.
      const resultError = deriveToolResultError(result);
      // Snapshot synchronously (see InstrumentToolCallEvent.captureResult):
      // the record pipeline runs in the background queue, after the caller —
      // and, in v2, the SDK's response encoder — may have mutated the result.
      const recordedResult = event.captureResult ? event.captureResult(result) : result;
      await recordToolCall({
        ...event,
        args,
        telemetry,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        ...(resultError === undefined
          ? { status: "ok" as const, result: recordedResult }
          : { status: "error" as const, result: recordedResult, error: resultError }),
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

  return {
    extractTelemetry: extractTelemetryArguments,
    recordToolCall,
    recordSessionInit,
    instrumentToolCall,
    flush,
  };
};
