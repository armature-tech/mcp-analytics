import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { z } from "zod";
import {
  applyTelemetryFieldMap,
  buildToolCallEvent,
  createAnalyticsRecorder,
  extractTelemetryArguments,
  planToolTelemetry,
  sanitizeValue,
  schemaDeclaresTelemetry,
  BASE64_REMOVED_PLACEHOLDER,
  REDACTION_FAILED_PLACEHOLDER,
  type AnalyticsIngestBatch,
  type JsonObjectSchema,
  type TelemetryMode,
} from "../src/index.js";

type ExtractionVector = {
  name: string;
  mode: TelemetryMode;
  args: unknown;
  expect_args: unknown;
  expect_telemetry: unknown;
};

type SanitizationVector = {
  name: string;
  value: unknown;
  expect: unknown;
};

const vectors = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "telemetry-contract-vectors.json",
    ),
    "utf8",
  ),
) as {
  extraction: ExtractionVector[];
  sanitization: SanitizationVector[];
};

test("cross-SDK contract: extraction vectors", () => {
  for (const vector of vectors.extraction) {
    const { args, telemetry } = extractTelemetryArguments(vector.args, vector.mode);
    assert.deepEqual(args, vector.expect_args, `${vector.name}: args`);
    assert.deepEqual(
      telemetry ?? null,
      vector.expect_telemetry,
      `${vector.name}: telemetry`,
    );
  }
});

test("cross-SDK contract: sanitization vectors", () => {
  for (const vector of vectors.sanitization) {
    assert.deepEqual(sanitizeValue(vector.value), vector.expect, vector.name);
  }
});

test("sanitizeValue keeps shared-but-acyclic content and cuts true cycles", () => {
  // Regression (Devin review): the same object referenced from two places
  // must be sanitized in both, not replaced by a circular marker on its
  // second appearance.
  const shared = { blob: "QUFBQQ==", note: "keep" };
  const twice = sanitizeValue([shared, shared]) as Array<Record<string, unknown>>;
  assert.deepEqual(twice[0], { blob: "[binary removed]", note: "keep" });
  assert.deepEqual(twice[1], { blob: "[binary removed]", note: "keep" });

  const cyclic: Record<string, unknown> = { note: "keep" };
  cyclic.self = cyclic;
  const sanitized = sanitizeValue(cyclic) as Record<string, unknown>;
  assert.equal(sanitized.self, "[circular]");
  assert.equal(sanitized.note, "keep");
});

test("captureTelemetry=false leaves schema and description untouched (scrub mode)", () => {
  const inputSchema = { type: "object", properties: { q: { type: "string" } } };
  const plan = planToolTelemetry("search", inputSchema, {
    armature: { captureTelemetry: false },
  });

  assert.equal(plan.mode, "scrub");
  assert.equal(plan.inputSchema, inputSchema);
  assert.equal(plan.applyDescription("Find things."), "Find things.");
  assert.equal(plan.applyDescription(undefined), undefined);
});

test("captureTelemetry default decorates schema and appends the hint (injected mode)", () => {
  const plan = planToolTelemetry("search", {
    type: "object",
    properties: { q: { type: "string" } },
  });

  assert.equal(plan.mode, "injected");
  const schema = plan.inputSchema as JsonObjectSchema;
  assert.ok(schema.properties?.telemetry, "telemetry property injected");
  assert.match(
    plan.applyDescription("Find things.") ?? "",
    /telemetry\.user_intent/,
  );
});

test("a tool that owns a top-level telemetry field is never decorated or stripped", () => {
  const owned = {
    type: "object",
    properties: { telemetry: { type: "string", description: "customer field" } },
  };
  assert.equal(schemaDeclaresTelemetry(owned), true);

  const plan = planToolTelemetry("customer-tool", owned);
  assert.equal(plan.mode, "owned");
  assert.equal(plan.inputSchema, owned);
  assert.equal(plan.applyDescription("Mine."), "Mine.");

  // Zod schemas declaring telemetry are owned too.
  assert.equal(
    schemaDeclaresTelemetry(z.object({ telemetry: z.string() })),
    true,
  );
  // Raw shapes as well.
  assert.equal(schemaDeclaresTelemetry({ telemetry: z.string() }), true);
  assert.equal(schemaDeclaresTelemetry({ q: z.string() }), false);
});

test("recorder drops telemetry end-to-end when capture is off, even from direct callers", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      captureTelemetry: false,
      delivery: "await",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  await recorder.recordToolCall({
    name: "search",
    args: { q: "x" },
    telemetry: { user_intent: "should never ship" },
    status: "ok",
    result: { ok: true },
  });

  const event = batches[0]?.events.find((e) => e.kind === "tool_call");
  assert.ok(event);
  assert.equal(event.metadata.user_intent, null);
  assert.equal(event.metadata.agent_thinking, null);
  assert.equal(event.metadata.user_frustration, null);
  assert.equal(event.metadata.user_turn, null);
  assert.equal(event.metadata.intent, null);
  assert.equal(event.metadata.context, null);
});

test("telemetryFieldMap exports mapped customer fields without stripping them", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      telemetryFieldMap: { user_intent: "purpose" },
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const seenArgs: unknown[] = [];
  const call = recorder.tool(
    {
      name: "customer-tool",
      inputSchema: {
        type: "object",
        properties: {
          purpose: { type: "string" },
          telemetry: { type: "string" },
        },
      },
    },
    (args) => {
      seenArgs.push(args);
      return { ok: true };
    },
  );

  await call({ purpose: "book a flight", telemetry: "customer value" });

  // Owned mode: the customer's args reach the handler untouched.
  assert.deepEqual(seenArgs[0], {
    purpose: "book a flight",
    telemetry: "customer value",
  });

  const event = batches[0]?.events.find((e) => e.kind === "tool_call");
  assert.ok(event);
  // Mapped field exported; the customer's own telemetry field is not
  // interpreted as Armature telemetry.
  assert.equal(event.metadata.user_intent, "book a flight");
  assert.equal(event.metadata.agent_thinking, null);
});

test("direct recordToolCall for a registered owned tool drops supplied telemetry", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });
  recorder.tool(
    {
      name: "owned-direct",
      inputSchema: {
        type: "object",
        properties: { telemetry: { type: "string" } },
      },
    },
    () => ({ ok: true }),
  );

  // An adapter bypassing dispatch() must not export telemetry for a tool the
  // customer owns — the choke point consults the registered mode.
  await recorder.recordToolCall({
    name: "owned-direct",
    args: { telemetry: "customer value" },
    telemetry: { user_intent: "adapter-supplied" },
    status: "ok",
    result: { ok: true },
  });

  const event = batches[0]?.events.find((e) => e.kind === "tool_call");
  assert.ok(event);
  assert.equal(event.metadata.user_intent, null);
});

test("applyTelemetryFieldMap never overrides explicit telemetry and validates types", () => {
  assert.deepEqual(
    applyTelemetryFieldMap(
      { user_intent: "explicit" },
      { purpose: "mapped", turn: 2, mood: "high" },
      { user_intent: "purpose", user_turn: "turn", user_frustration: "mood" },
    ),
    { user_intent: "explicit", user_turn: 2, user_frustration: "high" },
  );
  assert.deepEqual(
    applyTelemetryFieldMap(
      undefined,
      { turn: "not a number", mood: "irate" },
      { user_turn: "turn", user_frustration: "mood" },
    ),
    undefined,
  );
  assert.deepEqual(
    applyTelemetryFieldMap(
      { intent: "legacy explicit", context: "legacy context", frustration_level: "medium" },
      { purpose: "mapped", thinking: "mapped thinking", mood: "high" },
      { user_intent: "purpose", agent_thinking: "thinking", user_frustration: "mood" },
    ),
    { intent: "legacy explicit", context: "legacy context", frustration_level: "medium" },
  );
});

test("strict user_intent together with capture off fails fast", () => {
  assert.throws(
    () =>
      createAnalyticsRecorder({
        armature: { captureTelemetry: false },
        telemetry: { user_intent: "required" },
        // Internal strict-mode key — not part of the public config type.
      } as never),
    /captureTelemetry is false/,
  );
});

test("previews sanitize binary payloads and run the redact hook", () => {
  const event = buildToolCallEvent({
    toolName: "upload",
    input: {
      file: { type: "image", data: "QUFB".repeat(200), mimeType: "image/png" },
      note: "secret-token-12345",
    },
    output: { stored: "QUFB".repeat(200) },
    status: "ok",
    durationMs: 5,
    actorId: "actor",
    requestId: "req",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(5).toISOString(),
    redact: (value) =>
      JSON.parse(
        JSON.stringify(value).replaceAll("secret-token-12345", "[redacted]"),
      ),
  });

  assert.match(event.metadata.input_preview as string, /\[binary removed\]/);
  assert.doesNotMatch(event.metadata.input_preview as string, /secret-token-12345/);
  assert.match(event.metadata.input_preview as string, /\[redacted\]/);
  assert.match(event.script_source as string, /\[redacted\]/);
  assert.equal(
    (event.result_preview as string).includes(BASE64_REMOVED_PLACEHOLDER),
    true,
  );
});

test("a throwing redact hook fails closed instead of leaking the payload", () => {
  const event = buildToolCallEvent({
    toolName: "upload",
    input: { secret: "leak me not" },
    output: { alsoSecret: true },
    status: "error",
    errorMessage: "failed with leak me not",
    durationMs: 5,
    actorId: "actor",
    requestId: "req",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(5).toISOString(),
    telemetry: { user_intent: "quotes the user" },
    redact: () => {
      throw new Error("boom");
    },
  });

  assert.equal(
    event.metadata.input_preview,
    JSON.stringify(REDACTION_FAILED_PLACEHOLDER),
  );
  assert.equal(event.result_preview, JSON.stringify(REDACTION_FAILED_PLACEHOLDER));
  assert.equal(event.error, REDACTION_FAILED_PLACEHOLDER);
  assert.equal(event.metadata.user_intent, null);
  assert.doesNotMatch(event.script_source as string, /leak me not/);
});
