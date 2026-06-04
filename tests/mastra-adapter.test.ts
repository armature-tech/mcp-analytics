import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createAnalyticsRecorder } from "../src/index.js";
import {
  createMastraAnalytics,
  type MastraTool,
  type MastraToolExecute,
  type MastraToolMap,
  wrapMastraTools,
  wrapMastraToolsWithRecorder,
} from "../src/mastra.js";
import type { AnalyticsIngestBatch, JsonObjectSchema } from "../src/types.js";

const makeRecorder = (batches: AnalyticsIngestBatch[]) =>
  createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "mastra-test-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

test("wrapMastraTools decorates Zod inputSchema with the telemetry block", () => {
  const tools = {
    lookup_customer: {
      id: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: z.object({ customer_id: z.string() }),
      execute: async () => "noop",
    },
  };

  const wrapped = wrapMastraTools(tools);
  const decorated = wrapped.lookup_customer?.inputSchema as z.AnyZodObject;

  const parsed = decorated.parse({
    customer_id: "cus_1",
    telemetry: { intent: "look up account" },
  });
  assert.deepEqual(parsed, {
    customer_id: "cus_1",
    telemetry: { intent: "look up account" },
  });
});

test("wrapMastraTools preserves id, description, and unrelated tool properties", () => {
  const annotations = { readOnly: true };
  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      description: "Echo back.",
      inputSchema: z.object({ msg: z.string() }),
      annotations,
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraTools(tools);
  assert.equal(wrapped.echo?.id, "echo");
  assert.equal(wrapped.echo?.description, "Echo back.");
  assert.equal(wrapped.echo?.annotations, annotations);
  assert.notEqual(wrapped.echo?.execute, tools.echo?.execute);
});

test("wrapped execute strips telemetry from input before calling the original handler", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);
  let receivedInput: unknown = null;

  const tools: Record<string, MastraTool> = {
    lookup_customer: {
      id: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: z.object({ customer_id: z.string() }),
      execute: async (input) => {
        receivedInput = input;
        return { ok: true };
      },
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  const result = await wrapped.lookup_customer?.execute?.({
    customer_id: "cus_42",
    telemetry: { intent: "look up account" },
  });

  assert.deepEqual(receivedInput, { customer_id: "cus_42" });
  assert.deepEqual(result, { ok: true });

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.metadata.tool_name, "lookup_customer");
  assert.equal(toolCall?.metadata.intent, "look up account");
  assert.equal(toolCall?.ok, true);
  const inputPreview = JSON.parse(toolCall?.metadata.input_preview as string);
  assert.deepEqual(inputPreview, { customer_id: "cus_42" });
});

test("wrapped execute records errors and rethrows", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    boom: {
      id: "boom",
      inputSchema: z.object({ id: z.string() }),
      execute: async () => {
        throw new Error("kaboom");
      },
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  await assert.rejects(
    () =>
      wrapped.boom?.execute?.({
        id: "x",
        telemetry: { intent: "trigger error" },
      }) as Promise<unknown>,
    /kaboom/,
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, false);
  assert.equal(toolCall?.error, "kaboom");
  assert.equal(toolCall?.metadata.intent, "trigger error");
});

test("resolveExtra propagates sessionId and authInfo into the recorded event", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder, {}, {
    resolveExtra: (mastraContext) => {
      const ctx = mastraContext as { sessionId?: string; userId?: string };
      return {
        sessionId: ctx?.sessionId,
        authInfo: ctx?.userId ? { clientId: ctx.userId } : undefined,
      };
    },
  });

  await wrapped.echo?.execute?.(
    { msg: "hi", telemetry: { intent: "say hi" } },
    { sessionId: "session-mastra-1", userId: "user-7" },
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.session_id_hint, "session-mastra-1");
  const sessionInit = events.find((event) => event.kind === "session_init");
  assert.ok(sessionInit);
  assert.equal(sessionInit?.session_id_hint, "session-mastra-1");
  assert.equal(sessionInit?.metadata.client_name, "user-7");
});

test("config.armature.actorId resolver receives Mastra's context as ctx", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const seenCtx: unknown[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: ({ ctx }) => {
        seenCtx.push(ctx);
        return (ctx as { userId: string }).userId;
      },
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  await wrapped.echo?.execute?.({ msg: "hi" }, { userId: "user-9" });

  assert.deepEqual(seenCtx, [{ userId: "user-9" }]);
  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
});

test("tools without an inputSchema still get wrapped without throwing", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    ping: {
      id: "ping",
      execute: async () => "pong",
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  assert.equal(wrapped.ping?.inputSchema, undefined);

  const result = await wrapped.ping?.execute?.(undefined);
  assert.equal(result, "pong");

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.equal(toolCall?.metadata.tool_name, "ping");
});

test("tools without an execute are passed through untouched", () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    declarative_only: {
      id: "declarative_only",
      description: "Has no execute on purpose.",
      inputSchema: z.object({ x: z.string() }),
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  assert.equal(wrapped.declarative_only, tools.declarative_only);
});

test("falls back to the map key as tool name when id is missing", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    my_tool_key: {
      inputSchema: z.object({}),
      execute: async () => "ok",
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  await wrapped.my_tool_key?.execute?.({});

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.equal(toolCall?.metadata.tool_name, "my_tool_key");
});

test("createMastraAnalytics exposes recorder + flush for shared use", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const analytics = createMastraAnalytics({
    armature: {
      actorId: "shared-actor",
      emit: (batch) => {
        batches.push(batch);
      },
    },
  });

  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => input,
    },
  };

  const wrapped = analytics.wrapTools(tools);
  await wrapped.echo?.execute?.({ msg: "hi" });

  assert.equal(batches.length, 0);
  await analytics.flush();
  assert.equal(batches.length, 1);
  assert.equal(analytics.recorder.hasTool("echo"), false);
});

test("Mastra-wrapped tool with required-intent enforces telemetry.intent at parse time", () => {
  const tools: Record<string, MastraTool> = {
    strict: {
      id: "strict",
      inputSchema: z.object({ id: z.string() }),
      execute: async (input) => input,
    },
  };
  const wrapped = wrapMastraTools(tools, {
    telemetry: { intent: "required" },
  });
  const schema = wrapped.strict?.inputSchema as z.AnyZodObject;

  assert.throws(
    () => schema.parse({ id: "x" }),
    /telemetry/,
  );
  const ok = schema.parse({ id: "x", telemetry: { intent: "test" } });
  assert.deepEqual(ok, { id: "x", telemetry: { intent: "test" } });
});

// Structural simulation of Mastra's tool surface. We don't import @mastra/core
// (~59 MB unpacked) just to demonstrate a type — the contravariance fix only cares
// about the *shape* of the context param. If `MastraToolExecute['context']` ever
// regresses from `any` back to `unknown`, the un-cast assignments below will fail
// `tsc --noEmit` (run via `npm run typecheck:all`).
type ToolExecutionContext<TInput> = {
  context: TInput;
  runtimeContext: { get(key: string): unknown };
  // Mastra adds many more fields here in practice; one is enough to make the
  // overall context type narrower than `unknown`.
};
type MastraCreatedTool<TInput, TOutput> = {
  id: string;
  description?: string;
  inputSchema: z.ZodType<TInput>;
  execute: (
    inputData: TInput,
    context: ToolExecutionContext<TInput>,
  ) => Promise<TOutput>;
};

const createTool = <TInput, TOutput>(
  def: MastraCreatedTool<TInput, TOutput>,
): MastraCreatedTool<TInput, TOutput> => def;

test("Mastra-shaped tool with narrower context assigns into wrapMastraTools without a cast (contravariance fix)", () => {
  // This is the call site that previously required
  //   wrapMastraTools(tools as unknown as Parameters<typeof wrapMastraTools>[0], ...)
  // and a matching cast on the return. If `MastraToolExecute['context']` regresses
  // to `unknown`, this assignment fails to typecheck.
  const lookup = createTool({
    id: "lookup_customer",
    description: "Look up a customer.",
    inputSchema: z.object({ customer_id: z.string() }),
    execute: async (input, ctx) => {
      // Narrower context is reachable inside the original handler — that's the
      // whole reason we can't use `unknown` on the SDK side.
      ctx.runtimeContext.get("session");
      return { found: input.customer_id };
    },
  });

  const toolMap: MastraToolMap = { lookup_customer: lookup };
  const wrapped = wrapMastraTools(toolMap);
  assert.ok(wrapped.lookup_customer);

  // And the narrower execute signature directly satisfies MastraToolExecute —
  // no cast needed at the function-value level either.
  const _checkAssignable: MastraToolExecute = lookup.execute;
  void _checkAssignable;
});

test("nudged JSON Schema also flows through wrapMastraTools for tools using JSON Schema inputSchema", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    lookup: {
      id: "lookup",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  const schema = wrapped.lookup?.inputSchema as JsonObjectSchema;
  assert.ok(schema.properties?.telemetry);

  await wrapped.lookup?.execute?.({
    id: "cus_1",
    telemetry: { intent: "lookup via JSON schema" },
  });

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.equal(toolCall?.metadata.intent, "lookup via JSON schema");
});
