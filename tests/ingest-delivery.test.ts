import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultMcpAnalyticsConfig,
  IngestDeliveryError,
  postTelemetryEvent,
} from "../src/emit.js";

const batch = { schema_version: 1 as const, events: [] };
const config = {
  armature: {
    apiKey: "ami_eu_test-key-that-must-not-appear",
    endpointUrl: "https://eu.armature.tech/api/mcp-analytics/ingest",
  },
};

test("ingest delivery uses a five-second per-attempt timeout", () => {
  assert.equal(defaultMcpAnalyticsConfig.armature.timeoutMs, 5_000);
});

test("ingest delivery retries a transient response once", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"error":{"code":"temporarily_unavailable"}}', { status: 503 })
      : new Response(null, { status: 202 });
  };
  try {
    const result = await postTelemetryEvent(batch, config);
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingest delivery does not retry a 401 and preserves its stable code", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      '{"error":{"code":"ingest_key_wrong_region","message":"ami_eu_secret"}}',
      { status: 401 },
    );
  };
  try {
    await assert.rejects(postTelemetryEvent(batch, config), (error: unknown) => {
      assert.ok(error instanceof IngestDeliveryError);
      assert.equal(error.code, "ingest_key_wrong_region");
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.doesNotMatch(error.message, /secret|test-key/);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingest delivery retries network failures once and reports structured failure", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("socket failed");
  };
  try {
    await assert.rejects(postTelemetryEvent(batch, config), (error: unknown) => {
      assert.ok(error instanceof IngestDeliveryError);
      assert.equal(error.code, "ingest_connection_failed");
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 2);
      return true;
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingest delivery applies the timeout to each of two attempts", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("timed out", "AbortError"));
      }, { once: true });
    });
  };
  try {
    await assert.rejects(
      postTelemetryEvent(batch, { ...config, armature: { ...config.armature, timeoutMs: 5 } }),
      (error: unknown) => {
        assert.ok(error instanceof IngestDeliveryError);
        assert.equal(error.code, "ingest_timeout");
        assert.equal(error.attempts, 2);
        return true;
      },
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
