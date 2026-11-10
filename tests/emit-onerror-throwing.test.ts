import assert from "node:assert/strict";
import test from "node:test";
import { emitTelemetryEvent, reportEmitError } from "../src/emit.js";
import type { AnalyticsIngestBatch, McpAnalyticsConfig } from "../src/types.js";

const batch = { schema_version: 1, events: [{}] } as unknown as AnalyticsIngestBatch;

// The onError hook contract (types.ts) does not forbid throwing, and a hook that
// reads shared state is easy to make throw. A throwing hook must never escape
// telemetry delivery: on the background (default) path it would surface as an
// unhandledRejection and crash the host whose tool call had already succeeded.
const throwingOnError: McpAnalyticsConfig = {
  armature: {
    apiKey: "ami_test_secret",
    endpointUrl: "https://example.test/ingest",
    delivery: "await",
    onError: () => {
      throw new Error("integrator onError blew up");
    },
  },
};

test("reportEmitError swallows a throwing onError hook", () => {
  assert.doesNotThrow(() =>
    reportEmitError(new Error("delivery failed"), batch, throwingOnError),
  );
});

test("a throwing onError does not reject the await delivery path", async () => {
  const originalFetch = globalThis.fetch;
  // 200 body that rejects the events -> emit raises -> reportEmitError -> onError throws.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ accepted: 0, rejected: [{ event_id: "e1", reason: "persist_error" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    await assert.doesNotReject(() => emitTelemetryEvent(batch, throwingOnError));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
