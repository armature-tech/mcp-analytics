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

export const postTelemetryEvent = async (
  batch: AnalyticsIngestBatch,
  config: McpAnalyticsConfig = defaultMcpAnalyticsConfig,
) => {
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

      if (response.ok) {
        return { skipped: false, ok: true, status: response.status, attempts: attempt };
      }

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

export const createFlushableEmitter = (config: McpAnalyticsConfig) => {
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
