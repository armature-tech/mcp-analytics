import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAnalyticsRecorder,
  createPrivacyQueue,
  PRIVACY_QUEUE_CAPACITY,
  REDACTION_FAILED_PLACEHOLDER,
  type AnalyticsIngestBatch,
  type AnalyticsIngestEvent,
} from "../src/index.js";

const event = (id: number): AnalyticsIngestEvent => ({
  event_id: String(id),
  kind: "tool_call",
  actor_id: "actor",
  session_id_hint: null,
  started_at: new Date(0).toISOString(),
  finished_at: new Date(0).toISOString(),
  duration_ms: 0,
  ok: true,
  error: null,
  metadata: {},
  script_source: null,
  script_source_truncated: false,
  result_preview: null,
  result_truncated: false,
  calls: [],
  logs: [],
  search_calls: [],
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("privacy queue preserves FIFO and naturally batches arrivals behind a slow POST", async () => {
  const gate = deferred();
  const batches: string[][] = [];
  let sends = 0;
  const queue = createPrivacyQueue({ armature: { emit: async (batch) => {
    batches.push(batch.events.map((item) => item.event_id));
    if (sends++ === 0) await gate.promise;
  } } });

  await queue.enqueue(() => [event(0)]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue.enqueue(() => [event(1)]);
  await queue.enqueue(() => [event(2)]);
  gate.resolve();
  await queue.flush();
  assert.deepEqual(batches, [["0"], ["1", "2"]]);
});

test("privacy queue drops the oldest candidate on overflow and flush drains all stages", async () => {
  const ids: string[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const queue = createPrivacyQueue({ armature: { emit: (batch) => {
      ids.push(...batch.events.map((item) => item.event_id));
    } } });
    for (let id = 0; id <= PRIVACY_QUEUE_CAPACITY; id += 1) {
      await queue.enqueue(() => [event(id)]);
    }
    await queue.flush();
    assert.equal(ids.length, PRIVACY_QUEUE_CAPACITY);
    assert.equal(ids[0], "1");
    assert.equal(ids.at(-1), String(PRIVACY_QUEUE_CAPACITY));
    assert.equal(warnings.filter((args) => String(args[0]).includes("overflow")).length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("await delivery waits for finalization and export", async () => {
  const finalizeGate = deferred();
  const emitGate = deferred();
  const steps: string[] = [];
  const queue = createPrivacyQueue({ armature: {
    delivery: "await",
    emit: async () => { steps.push("emit"); await emitGate.promise; },
  } });
  const work = queue.enqueue(async () => {
    steps.push("finalize");
    await finalizeGate.promise;
    return [event(1)];
  });
  await Promise.resolve();
  assert.deepEqual(steps, ["finalize"]);
  finalizeGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ["finalize", "emit"]);
  emitGate.resolve();
  await work;
});

test("schedule hook receives the background drain promise", async () => {
  const scheduled: Promise<void>[] = [];
  const queue = createPrivacyQueue({ armature: {
    schedule: (work) => { scheduled.push(work); },
    emit: () => {},
  } });
  await queue.enqueue(() => [event(1)]);
  assert.equal(scheduled.length, 1);
  await scheduled[0];
});

test("disabled queues neither finalize nor emit", async () => {
  let finalized = false;
  let emitted = false;
  const queue = createPrivacyQueue({ armature: {
    enabled: false,
    emit: () => { emitted = true; },
  } });
  await queue.enqueue(() => {
    finalized = true;
    return [event(1)];
  });
  await queue.flush();
  assert.equal(finalized, false);
  assert.equal(emitted, false);
});

test("redactEvent can mutate, drop, and fail closed", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({ armature: {
    delivery: "await",
    actorId: "actor",
    redactEvent: async (candidate) => {
      if (candidate.toolName === "drop") return null;
      if (candidate.toolName === "throw") throw new Error("hook failed");
      return { ...candidate, input: { safe: true }, toolName: "mutated" };
    },
    emit: (batch) => { batches.push(batch); },
  } });

  await recorder.recordToolCall({ name: "keep", args: { password: "secret" }, status: "ok" });
  await recorder.recordToolCall({ name: "drop", args: { secret: "secret" }, status: "ok" });
  await recorder.recordToolCall({ name: "throw", args: { secret: "leak" }, status: "error" });

  const toolEvents = batches.flatMap((batch) => batch.events).filter((item) => item.kind === "tool_call");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0]?.metadata.tool_name, "mutated");
  assert.deepEqual(JSON.parse(toolEvents[0]?.metadata.input_preview as string), { safe: true });
  assert.equal(toolEvents[1]?.metadata.input_preview, JSON.stringify(REDACTION_FAILED_PLACEHOLDER));
  assert.equal(toolEvents[1]?.error, REDACTION_FAILED_PLACEHOLDER);
  assert.equal(JSON.stringify(toolEvents).includes("leak"), false);
});

test("background recorder returns before an async redactEvent completes", async () => {
  const hookGate = deferred();
  let emitted = false;
  const recorder = createAnalyticsRecorder({ armature: {
    redactEvent: async (candidate) => { await hookGate.promise; return candidate; },
    emit: () => { emitted = true; },
  } });
  await recorder.recordToolCall({ name: "background", status: "ok" });
  assert.equal(emitted, false);
  hookGate.resolve();
  await recorder.flush();
  assert.equal(emitted, true);
});
