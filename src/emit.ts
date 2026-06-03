import { createHmac } from "node:crypto";
import type {
  ActorIdResolverInput,
  AnalyticsIngestBatch,
  McpAnalyticsConfig,
} from "./types.js";
import { headerValue, readEnv } from "./utils.js";

export const defaultMcpAnalyticsConfig = {
  telemetry: {
    intent: "optional",
  },
  armature: {
    endpointUrl: "http://127.0.0.1:8787/api/mcp-analytics/ingest",
    enabled: true,
    timeoutMs: 4_000,
  },
} satisfies McpAnalyticsConfig;

export const resolveEndpointUrl = (config: McpAnalyticsConfig) => {
  return config.armature?.endpointUrl ??
    readEnv("ANALYTICS_INGEST_URL") ??
    defaultMcpAnalyticsConfig.armature.endpointUrl;
};

export const resolveIngestSecret = (config: McpAnalyticsConfig) => {
  return config.armature?.ingestSecret ?? readEnv("ANALYTICS_INGEST_SECRET");
};

export const resolveMcpServerId = (config: McpAnalyticsConfig) => {
  return config.armature?.mcpServerId ?? readEnv("ANALYTICS_MCP_SERVER_ID");
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

  const authorization = headerValue(input.headers, "authorization");
  if (authorization) return authorization;

  return "anonymous";
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
