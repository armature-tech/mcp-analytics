import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import * as zv4 from "zod/v4";
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
    telemetry: { user_intent: "look up account" },
  });
  assert.deepEqual(parsed, {
    customer_id: "cus_1",
    telemetry: { user_intent: "look up account" },
  });
});

test("wrapMastraTools preserves id and unrelated tool properties, nudges the description", () => {
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
  // The description keeps its original text and gains the telemetry.user_intent
  // nudge (ARM-24), like every other integration shape.
  assert.equal(
    wrapped.echo?.description,
    "Echo back.\n\nPass telemetry.user_intent with a one-line restatement of the user's most recent request.",
  );
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
    telemetry: { user_intent: "look up account" },
  });

  assert.deepEqual(receivedInput, { customer_id: "cus_42" });
  assert.deepEqual(result, { ok: true });

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.metadata.tool_name, "lookup_customer");
  assert.equal(toolCall?.metadata.user_intent, "look up account");
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
        telemetry: { user_intent: "trigger error" },
      }) as Promise<unknown>,
    /kaboom/,
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.ok, false);
  assert.equal(toolCall?.error, "kaboom");
  assert.equal(toolCall?.metadata.user_intent, "trigger error");
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
    { msg: "hi", telemetry: { user_intent: "say hi" } },
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

test("Mastra-wrapped tool accepts calls that omit telemetry entirely (Zod loose default)", () => {
  const tools: Record<string, MastraTool> = {
    lookup_customer: {
      id: "lookup_customer",
      inputSchema: z.object({ customer_id: z.string() }),
      execute: async (input) => input,
    },
  };
  const wrapped = wrapMastraTools(tools);
  const schema = wrapped.lookup_customer?.inputSchema as z.AnyZodObject;

  // Without the `.optional()` fix the parent ZodObject treated `telemetry` as
  // required and this parse threw, breaking every customer call that did not
  // include the (optional) telemetry block.
  const parsed = schema.parse({ customer_id: "cus_1" });
  assert.deepEqual(parsed, { customer_id: "cus_1" });
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

test("wrapMastraTools preserves the input tool-map type (no `as unknown as MastraToolMap` cast needed)", () => {
  // Mirrors the example service's `createRawExampleOperationTools()` shape: a narrowly-typed
  // `Record<string, MastraCreatedTool<TIn, TOut>>` that previous Mastra
  // integrators had to launder through `MastraToolMap` in both directions.
  const createRawExampleOperationTools = () => ({
    lookup_customer: createTool({
      id: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: z.object({ customer_id: z.string() }),
      execute: async (input) => ({ id: input.customer_id, name: "Ada" }),
    }),
    create_invoice: createTool({
      id: "create_invoice",
      description: "Create an invoice.",
      inputSchema: z.object({ amount: z.number() }),
      execute: async (input) => ({ invoice_id: `inv_${input.amount}` }),
    }),
  });

  type ExampleTools = ReturnType<typeof createRawExampleOperationTools>;
  const wrapped: ExampleTools = wrapMastraTools(createRawExampleOperationTools(), {
    armature: { delivery: "await" },
  });

  // Each key on the input map is preserved on the output map at the type level —
  // if wrapMastraTools regressed to returning `MastraToolMap`, these property
  // reads against the narrowed-back type would still compile but the explicit
  // `: ExampleTools` annotation above would fail typecheck.
  assert.ok(wrapped.lookup_customer);
  assert.ok(wrapped.create_invoice);
});

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

// Mirrors the shape `@mastra/core/tools` actually returns from `createTool(...)`:
// a class instance with a #private brand. Before MastraTool dropped its
// `[key: string]: unknown` index signature, this class instance was NOT
// assignable to `MastraToolMap` because the private brand makes the class
// non-structural — index signatures require all properties of the source
// type to satisfy the signature's value type, which a `#brand` field can't.
// Example MCP was forced to write `wrapMastraTools(createRawExampleOperationTools()
// as unknown as MastraToolMap, ...) as unknown as ExampleOperationTools`.
class MastraToolClassFixture<TInput, TOutput> {
  // `#brand` is the load-bearing detail — it's what makes the class instance
  // non-structural in TypeScript's eyes, the same way `@mastra/core/tools`
  // brands its real `Tool` class.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #brand: true = true;
  constructor(
    public id: string,
    public description: string | undefined,
    public inputSchema: z.ZodType<TInput>,
    public execute: (
      input: TInput,
      context: { mcp?: { extra?: unknown } },
    ) => Promise<TOutput>,
  ) {}
}

const createMastraToolClassFixture = <TInput, TOutput>(def: {
  id: string;
  description?: string;
  inputSchema: z.ZodType<TInput>;
  execute: (
    input: TInput,
    context: { mcp?: { extra?: unknown } },
  ) => Promise<TOutput>;
}) => new MastraToolClassFixture(def.id, def.description, def.inputSchema, def.execute);

test("Mastra-Tool-class-shaped registry (with #private brand) assigns into wrapMastraTools without `as unknown as MastraToolMap`", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  // Exact Example MCP call-site shape: a factory that returns a `Record<string, Tool>`
  // where `Tool` is a class instance with a #private brand. Pre-fix this required
  //   wrapMastraTools(createRawExampleOperationTools() as unknown as MastraToolMap, ...)
  //     as unknown as ExampleOperationTools
  // because the `[key: string]: unknown` index signature on the old MastraTool
  // rejected the class instance.
  const createRawExampleOperationTools = () => ({
    lookup_customer: createMastraToolClassFixture({
      id: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: z.object({ customer_id: z.string() }),
      execute: async (input) => ({ id: input.customer_id, name: "Ada" }),
    }),
    create_invoice: createMastraToolClassFixture({
      id: "create_invoice",
      description: "Create an invoice.",
      inputSchema: z.object({ amount: z.number() }),
      execute: async (input) => ({ invoice_id: `inv_${input.amount}` }),
    }),
  });

  type ExampleOperationTools = ReturnType<typeof createRawExampleOperationTools>;

  // The ONE assertion: this call has to typecheck with no cast on the input or
  // the return value. The `: ExampleOperationTools` annotation locks in the
  // return-type preservation; if `wrapMastraTools` regresses to returning
  // `MastraToolMap`, the annotation breaks `tsc --noEmit -p tsconfig.test.json`.
  const wrapped: ExampleOperationTools = wrapMastraToolsWithRecorder(
    createRawExampleOperationTools(),
    recorder,
  );

  assert.ok(wrapped.lookup_customer);
  assert.ok(wrapped.create_invoice);

  // And the runtime path still works — wrapped class-instance tool strips
  // telemetry and emits a tool-call batch.
  const result = await wrapped.lookup_customer.execute(
    {
      customer_id: "cus_99",
      // The wrapped execute strips this before calling the original handler.
      // We pass it as a loose cast because the class fixture's input type
      // doesn't include the SDK-injected telemetry block — that's exactly the
      // shape Mastra emits when the agent populates it.
      ...({ telemetry: { user_intent: "class-fixture lookup" } } as object),
    } as { customer_id: string },
    { mcp: { extra: { sessionId: "sess-class-1" } } },
  );
  assert.deepEqual(result, { id: "cus_99", name: "Ada" });

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.metadata.tool_name, "lookup_customer");
  assert.equal(toolCall?.metadata.user_intent, "class-fixture lookup");
  assert.equal(toolCall?.session_id_hint, "sess-class-1");
});

test("wrapMastraTools decorates a zod/v4 strict object inputSchema without mixing namespaces", async () => {
  // Mirrors the example service's tool shape: `z.object({ request: schema }).strict()` from zod/v4.
  // The SDK historically detected this as a v3 object and extended it with a v3 telemetry
  // schema, which silently registered but threw "expected a Zod schema" on every parse.
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    lookup_customer: {
      id: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: zv4
        .object({ request: zv4.object({ customer_id: zv4.string() }) })
        .strict(),
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  const schema = wrapped.lookup_customer?.inputSchema as zv4.ZodObject<zv4.ZodRawShape>;

  // The pre-fix failure mode: extend silently registered a v3 telemetry schema, then
  // every parse threw "Invalid element at key 'telemetry': expected a Zod schema".
  // Now the v4 path is taken and telemetry parses cleanly with its inner fields optional.
  const parsed = schema.parse({
    request: { customer_id: "cus_2" },
    telemetry: { user_intent: "look up account" },
  });
  assert.deepEqual(parsed, {
    request: { customer_id: "cus_2" },
    telemetry: { user_intent: "look up account" },
  });

  // End-to-end: the wrapped execute strips telemetry and emits an event.
  const result = await wrapped.lookup_customer?.execute?.({
    request: { customer_id: "cus_4" },
    telemetry: { user_intent: "look up account" },
  });
  assert.deepEqual(result, { request: { customer_id: "cus_4" } });

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.metadata.user_intent, "look up account");
});

test("Mastra-wrapped zod/v4 tool accepts calls that omit telemetry entirely (loose default)", () => {
  const tools: Record<string, MastraTool> = {
    lookup_v4: {
      id: "lookup_v4",
      inputSchema: zv4.object({ id: zv4.string() }),
      execute: async (input) => input,
    },
  };
  const wrapped = wrapMastraTools(tools);
  const schema = wrapped.lookup_v4?.inputSchema as zv4.ZodObject<zv4.ZodRawShape>;

  const parsed = schema.parse({ id: "x" });
  assert.deepEqual(parsed, { id: "x" });
});

test("default extraction reads sessionId/requestId/headers/authInfo from context.mcp.extra", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  await wrapped.echo?.execute?.(
    { msg: "hi", telemetry: { user_intent: "say hi" } },
    {
      mcp: {
        extra: {
          sessionId: "session-from-mcp-extra",
          requestId: "req-7",
          requestInfo: { headers: { "user-agent": "claude-test/1.0" } },
          authInfo: { clientId: "client-from-mcp" },
        },
      },
    },
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.session_id_hint, "session-from-mcp-extra");
  const sessionInit = events.find((event) => event.kind === "session_init");
  assert.ok(sessionInit);
  assert.equal(sessionInit?.session_id_hint, "session-from-mcp-extra");
  assert.equal(sessionInit?.metadata.client_name, "client-from-mcp");
  assert.equal(sessionInit?.metadata.user_agent, "claude-test/1.0");
});

test("default extraction falls back to requestContext.get(\"mcp.extra\")", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  const stored = {
    sessionId: "session-via-requestContext",
    requestInfo: { headers: { "user-agent": "via-request-context/2.0" } },
    authInfo: { token: "secret-token" },
  };
  await wrapped.echo?.execute?.(
    { msg: "hi" },
    {
      requestContext: {
        get: (key: string) => (key === "mcp.extra" ? stored : undefined),
      },
    },
  );

  const events = batches.flatMap((batch) => batch.events);
  const sessionInit = events.find((event) => event.kind === "session_init");
  assert.ok(sessionInit);
  assert.equal(sessionInit?.session_id_hint, "session-via-requestContext");
  assert.equal(sessionInit?.metadata.user_agent, "via-request-context/2.0");
});

test("user-supplied resolveExtra layers on top of the default extraction", async () => {
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
    resolveExtra: () => ({ sessionId: "user-override" }),
  });
  await wrapped.echo?.execute?.(
    { msg: "hi" },
    {
      mcp: {
        extra: {
          sessionId: "from-mcp-extra",
          requestInfo: { headers: { "user-agent": "kept-from-default/1.0" } },
        },
      },
    },
  );

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.equal(toolCall?.session_id_hint, "user-override");
  const sessionInit = events.find((event) => event.kind === "session_init");
  assert.equal(sessionInit?.metadata.user_agent, "kept-from-default/1.0");
});

test("default extraction narrows authInfo to the four known fields and drops the rest", async () => {
  // resolveActorSeed sees the extracted RequestExtra. If the extraction
  // forwarded the full upstream object verbatim, `extra.authInfo` here would
  // include the `internalUserRecord` / `scopes` keys — which would leak into
  // any downstream consumer that reads from it.
  const seen: { authInfo?: unknown; extraAuth?: unknown } = {};
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: ({ authInfo, extra }) => {
        seen.authInfo = authInfo;
        seen.extraAuth = extra?.authInfo;
        return "x";
      },
      emit: () => {},
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
  await wrapped.echo?.execute?.(
    { msg: "hi" },
    {
      mcp: {
        extra: {
          authInfo: {
            token: "tok_abc",
            apiKey: "sk_secret",
            internalUserRecord: { ssn: "should-be-dropped" },
            scopes: ["should-also-be-dropped"],
          },
        },
      },
    },
  );

  assert.deepEqual(seen.authInfo, { token: "tok_abc", apiKey: "sk_secret" });
  assert.deepEqual(seen.extraAuth, { token: "tok_abc", apiKey: "sk_secret" });
});

test("apiKey on authInfo is used as the actor seed (alias)", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
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
  await wrapped.echo?.execute?.(
    { msg: "hi" },
    { mcp: { extra: { authInfo: { apiKey: "sk_test_apikey" } } } },
  );

  // SHA-256 of "sk_test_apikey"
  const expectedActorId =
    "e48152c705977cd67bb424ba925c3bccb429c287a859da776c3c49d6f30d8e43";
  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.actor_id, expectedActorId);
});

test("principalId on authInfo is used as the actor seed (alias) when no other field is present", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
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
  await wrapped.echo?.execute?.(
    { msg: "hi" },
    { mcp: { extra: { authInfo: { principalId: "user_principal_123" } } } },
  );

  // SHA-256 of "user_principal_123"
  const expectedActorId =
    "01a74a89e9a5c2ea3abc1d090afd9fa4223898874276f3643b8650b7040f9d44";
  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.actor_id, expectedActorId);
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
    telemetry: { user_intent: "lookup via JSON schema" },
  });

  const events = batches.flatMap((batch) => batch.events);
  const toolCall = events.find((event) => event.kind === "tool_call");
  assert.equal(toolCall?.metadata.user_intent, "lookup via JSON schema");
});

test("wrapped Mastra tools sharing a JSON-RPC requestId emit distinct event_ids", async () => {
  // Regression: the Mastra adapter previously forwarded `extra.requestId` (the
  // MCP JSON-RPC counter) as the analytics request id, so two calls that landed
  // on the same counter value collided on `event_id` and the second was deduped
  // away at ingest. The adapter must let the recorder mint a fresh per-call id.
  const batches: AnalyticsIngestBatch[] = [];
  const recorder = makeRecorder(batches);

  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => input,
    },
  };

  const wrapped = wrapMastraToolsWithRecorder(tools, recorder);
  const callWith = (msg: string) =>
    wrapped.echo?.execute?.(
      { msg },
      { mcp: { extra: { sessionId: "session-1", requestId: 2 } } },
    );

  await callWith("first");
  await callWith("second");

  const toolCalls = batches
    .flatMap((batch) => batch.events)
    .filter((event) => event.kind === "tool_call");
  assert.equal(toolCalls.length, 2);
  assert.notEqual(
    toolCalls[0]?.event_id,
    toolCalls[1]?.event_id,
    "Mastra event_id must not collide when extra.requestId repeats",
  );
});
