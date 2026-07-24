import type {
  ActorIdResolverInput,
  AnalyticsIngestBatch,
  McpAnalyticsConfig,
} from "./types.js";
import { headerValue, readEnv } from "./utils.js";

export const defaultMcpAnalyticsConfig = {
  armature: {
    endpointUrl: "https://app.armature.tech/api/mcp-analytics/ingest",
    enabled: true,
    timeoutMs: 5_000,
  },
} satisfies McpAnalyticsConfig;

export const DEFAULT_INGEST_MAX_ATTEMPTS = 2;
export const DEFAULT_INGEST_RETRY_DELAY_MS = 100;

export class IngestDeliveryError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(message: string, options: {
    code: string;
    status?: number;
    retryable?: boolean;
    attempts: number;
    cause?: unknown;
  }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IngestDeliveryError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable === true;
    this.attempts = options.attempts;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const responseErrorCode = async (response: Response): Promise<string> => {
  const fallback = `ingest_http_${response.status}`;
  const text = (await response.text()).slice(0, 4_096);
  try {
    const payload = JSON.parse(text) as {
      error?: { code?: unknown };
      errorCode?: unknown;
    };
    const candidate = typeof payload.error?.code === "string"
      ? payload.error.code
      : typeof payload.errorCode === "string"
        ? payload.errorCode
        : fallback;
    return /^[a-z0-9][a-z0-9_:-]{0,99}$/i.test(candidate) ? candidate : fallback;
  } catch {
    return fallback;
  }
};

export const resolveEndpointUrl = (config: McpAnalyticsConfig) => {
  return config.armature?.endpointUrl ??
    readEnv("ANALYTICS_INGEST_URL") ??
    defaultMcpAnalyticsConfig.armature.endpointUrl;
};

export const resolveApiKey = (config: McpAnalyticsConfig) => {
  return config.armature?.apiKey ?? readEnv("ANALYTICS_INGEST_API_KEY");
};

export const resolveActorSeed = async (
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
  if (input.authInfo?.apiKey) return input.authInfo.apiKey;
  if (input.authInfo?.principalId) return input.authInfo.principalId;

  const authorization = headerValue(input.headers, "authorization");
  if (authorization) return authorization;

  return "anonymous";
};

const MAX_ACTOR_IDENTIFIER_BYTES = 8 * 1024;

/** Resolve the optional caller-provided identifier without interpreting it. */
export const resolveActorIdentifier = async (
  config: McpAnalyticsConfig,
  input: ActorIdResolverInput,
): Promise<string | undefined> => {
  const configured = config.armature?.actorIdentifier;
  if (configured === undefined) return undefined;
  const value = typeof configured === "function" ? await configured(input) : configured;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return new TextEncoder().encode(value).byteLength <= MAX_ACTOR_IDENTIFIER_BYTES
    ? value
    : undefined;
};

type IngestRejection = { event_id?: string | null; reason?: string };

export type IngestResult = {
  skipped: boolean;
  ok?: boolean;
  reason?: string;
  status?: number;
  attempts?: number;
  accepted?: number;
  rejected?: IngestRejection[];
  duplicateCount?: number;
};

/**
 * Ingest answers HTTP 200 even when it refuses events in the response body
 * (validation, quota, schema drift — `rejected` non-empty, or everything
 * refused with nothing accepted). A producer that checks only the status code
 * treats that as delivered and never fires `onError` (#1403). This carries the
 * refusal so the emit path can surface it through the normal error channel.
 */
export class IngestRejectedError extends Error {
  readonly rejected: IngestRejection[];
  readonly accepted: number;
  constructor(rejected: IngestRejection[], accepted: number) {
    const reasons = Array.from(
      new Set(rejected.map((item) => item?.reason).filter((r): r is string => Boolean(r))),
    );
    const detail = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
    super(`Armature ingest rejected ${rejected.length} event(s)${detail}`);
    this.name = "IngestRejectedError";
    this.rejected = rejected;
    this.accepted = accepted;
  }
}

// A 200 that refuses events in-body: any explicit rejection, or nothing
// accepted from a non-empty batch. Server-side dedup counts as accepted, so a
// benign session_init re-delivery does NOT trip this.
export const describeIngestRejection = (
  result: IngestResult,
  eventCount: number,
): IngestRejectedError | null => {
  if (result.skipped) return null;
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  const accepted = typeof result.accepted === "number" ? result.accepted : undefined;
  if (rejected.length > 0) return new IngestRejectedError(rejected, accepted ?? 0);
  if (accepted === 0 && eventCount > 0) return new IngestRejectedError([], 0);
  return null;
};

export const postTelemetryEvent = async (
  batch: AnalyticsIngestBatch,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
): Promise<IngestResult> => {
  const endpointUrl = resolveEndpointUrl(config);
  const apiKey = resolveApiKey(config);

  if (!apiKey) {
    return { skipped: true, reason: "ingest_config_missing" };
  }

  const body = JSON.stringify(batch);
  const timeoutMs = config.armature?.timeoutMs ?? defaultMcpAnalyticsConfig.armature.timeoutMs;

  for (let attempt = 1; attempt <= DEFAULT_INGEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const code = await responseErrorCode(response);
        if (retryable && attempt < DEFAULT_INGEST_MAX_ATTEMPTS) {
          await sleep(DEFAULT_INGEST_RETRY_DELAY_MS);
          continue;
        }
        throw new IngestDeliveryError(
          `Armature ingest failed with HTTP ${response.status} (${code})`,
          { code, status: response.status, retryable, attempts: attempt },
        );
      }

      const text = await response.text();
      // Ingest can report in-band rejection/dedup on a successful status. A
      // non-JSON body means rejections are unobservable, not that delivery
      // failed.
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      return {
        skipped: false,
        ok: true,
        status: response.status,
        attempts: attempt,
        accepted: typeof parsed.accepted === "number" ? parsed.accepted : undefined,
        rejected: Array.isArray(parsed.rejected) ? (parsed.rejected as IngestRejection[]) : [],
        duplicateCount:
          typeof parsed.duplicate_count === "number" ? parsed.duplicate_count : undefined,
      };
    } catch (error) {
      if (error instanceof IngestDeliveryError) throw error;
      const timedOut = (error as { name?: string } | null)?.name === "AbortError";
      if (attempt < DEFAULT_INGEST_MAX_ATTEMPTS) {
        await sleep(DEFAULT_INGEST_RETRY_DELAY_MS);
        continue;
      }
      throw new IngestDeliveryError(
        timedOut
          ? `Armature ingest timed out after ${timeoutMs}ms`
          : "Armature ingest connection failed",
        {
          code: timedOut ? "ingest_timeout" : "ingest_connection_failed",
          retryable: true,
          attempts: attempt,
          cause: error,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new IngestDeliveryError("Armature ingest delivery failed", {
    code: "ingest_delivery_failed",
    attempts: DEFAULT_INGEST_MAX_ATTEMPTS,
  });
};

// The default network emit for every delivery path (privacy queue, flushable
// emitter, one-shot emit): POST, then raise on in-body rejection so the caller's
// try/catch routes it to `onError`, just like a transport failure. This MUST be
// the shared default so the recorder's real path (the privacy queue) also
// surfaces rejections (#1403).
export const postAndCheck = async (
  batch: AnalyticsIngestBatch,
  config: McpAnalyticsConfig,
): Promise<void> => {
  const result = await postTelemetryEvent(batch, config);
  const rejection = describeIngestRejection(result, batch.events.length);
  if (rejection) throw rejection;
};

export const reportEmitError = (
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
    ((telemetryBatch: AnalyticsIngestBatch) => postAndCheck(telemetryBatch, config));

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

export const createFlushableEmitter = (config: McpAnalyticsConfig) => {
  const pending = new Set<Promise<void>>();

  const emitBatch = (batch: AnalyticsIngestBatch) => {
    if (config.armature?.enabled === false) {
      return Promise.resolve();
    }

    const emit =
      config.armature?.emit ??
      ((telemetryBatch: AnalyticsIngestBatch) => postAndCheck(telemetryBatch, config));

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
