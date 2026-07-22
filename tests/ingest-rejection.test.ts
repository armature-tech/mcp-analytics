import assert from "node:assert/strict";
import test from "node:test";
import { describeIngestRejection, emitTelemetryEvent } from "../src/emit.js";
// IngestRejectedError deliberately comes from the public barrel: integrators
// identify a refused batch inside onError via `instanceof`, so the class being
// re-exported from the package entry point is part of the #1403 contract.
import { createAnalyticsRecorder, IngestRejectedError } from "../src/index.js";
import type { AnalyticsIngestBatch, McpAnalyticsConfig } from "../src/types.js";

const batchWith = (eventCount: number): AnalyticsIngestBatch =>
  ({
    schema_version: 1,
    events: Array.from({ length: eventCount }, () => ({}) as never),
  }) as AnalyticsIngestBatch;

const withMockedFetch = async (
  responseBody: string,
  status: number,
  run: () => Promise<void>,
) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(responseBody, { status, headers: { "content-type": "application/json" } });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const configWithOnError = (onError: (error: unknown) => void): McpAnalyticsConfig => ({
  armature: {
    apiKey: "ami_test_secret",
    endpointUrl: "https://example.test/ingest",
    delivery: "await",
    onError,
  },
});

test("describeIngestRejection: rejected list, all-rejected, clean, and dedup-only", () => {
  assert.ok(
    describeIngestRejection({ skipped: false, accepted: 0, rejected: [{ reason: "persist_error" }] }, 1)
      instanceof IngestRejectedError,
  );
  // accepted==0 with events>0 but no explicit rejections still fires.
  assert.ok(describeIngestRejection({ skipped: false, accepted: 0, rejected: [] }, 2) instanceof IngestRejectedError);
  // Clean accept: no rejection.
  assert.equal(describeIngestRejection({ skipped: false, accepted: 3, rejected: [] }, 3), null);
  // Dedup-only (benign session_init re-delivery counts as accepted): no rejection.
  assert.equal(describeIngestRejection({ skipped: false, accepted: 2, rejected: [], duplicateCount: 2 }, 2), null);
  // Skipped (no ingest key): no rejection.
  assert.equal(describeIngestRejection({ skipped: true }, 1), null);
});

test("emit fires onError with IngestRejectedError when the 200 body rejects events (#1403)", async () => {
  const errors: unknown[] = [];
  await withMockedFetch(
    JSON.stringify({ accepted: 0, rejected: [{ event_id: "e1", reason: "schema_version_mismatch" }], duplicate_count: 0 }),
    200,
    () => emitTelemetryEvent(batchWith(1), configWithOnError((error) => errors.push(error))),
  );
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof IngestRejectedError);
  assert.match((errors[0] as Error).message, /rejected 1 event\(s\).*schema_version_mismatch/);
});

test("emit does NOT fire onError on a clean 200 accept", async () => {
  const errors: unknown[] = [];
  await withMockedFetch(
    JSON.stringify({ accepted: 1, rejected: [], duplicate_count: 0 }),
    200,
    () => emitTelemetryEvent(batchWith(1), configWithOnError((error) => errors.push(error))),
  );
  assert.equal(errors.length, 0);
});

test("emit does NOT fire onError when the batch was only deduped", async () => {
  const errors: unknown[] = [];
  await withMockedFetch(
    JSON.stringify({ accepted: 1, rejected: [], duplicate_count: 1 }),
    200,
    () => emitTelemetryEvent(batchWith(1), configWithOnError((error) => errors.push(error))),
  );
  assert.equal(errors.length, 0);
});

// The recorder's real delivery path is the privacy queue, NOT emitTelemetryEvent.
// This exercises createAnalyticsRecorder end-to-end so a rejection on the live
// path actually reaches onError (#1403 regression guard).
test("recorder surfaces an in-body rejection through onError (live queue path)", async () => {
  const errors: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ accepted: 0, rejected: [{ event_id: "e1", reason: "persist_error" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const recorder = createAnalyticsRecorder({
      armature: {
        apiKey: "ami_test_secret",
        endpointUrl: "https://example.test/ingest",
        delivery: "await",
        actorId: "anonymous",
        onError: (error) => errors.push(error),
      },
    });
    await recorder.recordToolCall({
      name: "lookup_customer",
      args: {},
      sessionId: "sess-A",
      requestId: "5",
      status: "ok",
    });
    await recorder.flush();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(errors.length >= 1, "recorder must report the rejection through onError");
  assert.ok(errors.some((e) => e instanceof IngestRejectedError));
});
