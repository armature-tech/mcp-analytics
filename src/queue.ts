import {
  postAndCheck,
  reportEmitError,
} from "./emit.js";
import type {
  AnalyticsIngestBatch,
  AnalyticsIngestEvent,
  McpAnalyticsConfig,
} from "./types.js";
import { readEnv, SCHEMA_VERSION } from "./utils.js";

export const PRIVACY_QUEUE_CAPACITY = 1_000;
export const PRIVACY_QUEUE_BATCH_SIZE = 20;

export type PrivacyQueueFinalizer = () =>
  | AnalyticsIngestEvent[]
  | null
  | Promise<AnalyticsIngestEvent[] | null>;

export type PrivacyQueue = {
  enqueue: (finalize: PrivacyQueueFinalizer) => Promise<void>;
  flush: () => Promise<void>;
};

let warnedServerlessWithoutSchedule = false;

const warn = (message: string, error?: unknown) => {
  // eslint-disable-next-line no-console
  console.warn(`[mcp-analytics] ${message}`, ...(error === undefined ? [] : [error]));
};

export const createPrivacyQueue = (config: McpAnalyticsConfig): PrivacyQueue => {
  const pending: PrivacyQueueFinalizer[] = [];
  let running: Promise<void> | null = null;
  let dropped = 0;
  let warnedDropped = false;

  const isEnabled = () => config.armature?.enabled !== false;

  if (
    isEnabled()
    && config.armature?.delivery !== "await"
    && !config.armature?.schedule
    && !warnedServerlessWithoutSchedule
    && (readEnv("AWS_LAMBDA_FUNCTION_NAME") || readEnv("VERCEL"))
  ) {
    warnedServerlessWithoutSchedule = true;
    warn("background delivery may be frozen by this serverless runtime; use delivery: \"await\" or armature.schedule");
  }

  const emit = async (batch: AnalyticsIngestBatch) => {
    const emitter = config.armature?.emit
      ?? ((value: AnalyticsIngestBatch) => postAndCheck(value, config));
    try {
      await emitter(batch);
    } catch (error) {
      reportEmitError(error, batch, config);
    }
  };

  const drain = async () => {
    while (pending.length > 0) {
      const items = pending.splice(0, PRIVACY_QUEUE_BATCH_SIZE);
      const events: AnalyticsIngestEvent[] = [];
      for (const finalize of items) {
        try {
          const finalized = await finalize();
          if (finalized) events.push(...finalized);
        } catch (error) {
          warn("privacy queue candidate failed and was dropped:", error);
        }
      }
      if (events.length > 0) {
        await emit({ schema_version: SCHEMA_VERSION, events });
      }
    }
  };

  const start = (deferred: boolean): Promise<void> => {
    if (running) return running;
    const gate = deferred
      ? new Promise<void>((resolve) => {
          if (typeof setImmediate === "function") setImmediate(resolve);
          else queueMicrotask(resolve);
        })
      : Promise.resolve();
    const task = gate
      .then(drain)
      .finally(() => {
        if (running === task) running = null;
        if (pending.length > 0 && isEnabled()) scheduleBackground();
      });
    running = task;
    return task;
  };

  const scheduleBackground = () => {
    const work = start(true);
    try {
      config.armature?.schedule?.(work);
    } catch (error) {
      warn("schedule hook threw; background work remains active:", error);
    }
  };

  const flush = async () => {
    if (!isEnabled()) return;
    while (running || pending.length > 0) {
      await (running ?? start(false));
    }
  };

  const enqueue = (finalize: PrivacyQueueFinalizer): Promise<void> => {
    if (!isEnabled()) return Promise.resolve();
    if (pending.length >= PRIVACY_QUEUE_CAPACITY) {
      pending.shift();
      dropped += 1;
      if (!warnedDropped) {
        warnedDropped = true;
        warn(`privacy queue overflow; dropped ${dropped} oldest candidate(s)`);
      }
    }
    pending.push(finalize);
    if (config.armature?.delivery === "await") return flush();
    if (!running) scheduleBackground();
    return Promise.resolve();
  };

  return { enqueue, flush };
};
