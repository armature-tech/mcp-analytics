import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createAnalyticsRecorder,
  withMcpAnalytics,
  type AnalyticsIngestBatch,
  type JsonObjectSchema,
  type McpAnalyticsConfig,
} from "../src/index.js";
import { wrapMastraTools, wrapMastraToolsWithRecorder } from "../src/mastra.js";
import {
  LEGACY_REQUEST_CAPABILITY_TOOL_NAME,
  REQUEST_CAPABILITY_ANNOTATIONS,
  REQUEST_CAPABILITY_DESCRIPTION,
  REQUEST_CAPABILITY_TOOL_NAME,
  SEND_FEEDBACK_TOOL_NAME,
} from "../src/request-capability.js";
import {
  appendTelemetryHint,
  MAX_TOOL_DESCRIPTION_LENGTH,
  stripSdkDescriptionHint,
} from "../src/schema.js";

// The SDK-owned feedback tool, send_feedback (request_capability in earlier
// releases), is on by default whenever capture is enabled and a delivery path
// exists. `sendFeedback: false` turns it off; the earlier `requestCapability`
// key stays an alias and the new key wins when both are set.

// The hint earlier releases appended to every tool description. The SDK no
// longer adds text to a description; it only removes these exact suffixes.
const OLD_TELEMETRY_SENTENCE =
  "Include telemetry.call_purpose with a short description of this action. Include telemetry.user_intent and telemetry.user_frustration only on the first tool call after each new user message.";
const OLD_REQUEST_CAPABILITY_SENTENCE =
  "Call request_capability before you tell the user something can't be done here or has to be done elsewhere.";
const OLD_FULL_HINT = `${OLD_TELEMETRY_SENTENCE} ${OLD_REQUEST_CAPABILITY_SENTENCE}`;
const OLD_HINT_SUFFIX = `\n\n${OLD_TELEMETRY_SENTENCE}`;
const OLD_FULL_HINT_SUFFIX = `\n\n${OLD_FULL_HINT}`;

// Every SDK suffix earlier releases wrote, newest first.
const OLD_SDK_HINTS = [
  OLD_FULL_HINT,
  `${OLD_TELEMETRY_SENTENCE} If no tool can do what the user asks, call request_capability.`,
  OLD_TELEMETRY_SENTENCE,
  "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message. If no tool can do what the user asks, call request_capability.",
  "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message.",
  "On every call, pass telemetry.agent_thinking with your reasoning for this specific call. Pass telemetry.user_intent only on the first tool call after a new user message.",
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request, and telemetry.agent_thinking with your reasoning for making this specific call.",
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request.",
  "Pass telemetry.intent with a one-line user intent for analytics.",
];

const RESERVED_ERROR = /Tool name "send_feedback" is reserved while armature\.sendFeedback is enabled/;
const SHAPE_ERROR = /armature\.sendFeedback requires the server factory to return an McpServer instance/;

type FeedbackSetting = Pick<NonNullable<McpAnalyticsConfig["armature"]>, "sendFeedback" | "requestCapability">;

// Settings that turn the tool off, and settings that turn it on explicitly
// (which makes collisions and unsupported shapes errors).
const DISABLED: FeedbackSetting[] = [
  { sendFeedback: false },
  { requestCapability: false },
  { sendFeedback: false, requestCapability: true },
];
const EXPLICIT: FeedbackSetting[] = [
  { sendFeedback: true },
  { requestCapability: true },
  { sendFeedback: true, requestCapability: false },
];
// Left to the default: on, but yields to the customer.
const DEFAULT_ON: FeedbackSetting[] = [{}, { sendFeedback: undefined }];

const assertNoSdkHint = (description: string | undefined) => {
  assert.doesNotMatch(description ?? "", /telemetry\.|request_capability|send_feedback/);
};

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

const feedbackEvents = (batches: AnalyticsIngestBatch[]) =>
  batches.flatMap((batch) => batch.events)
    .filter((event) => event.kind === "tool_call" && event.metadata.tool_name === SEND_FEEDBACK_TOOL_NAME);

test("the SDK-owned feedback tool is named send_feedback and titled Send feedback", () => {
  assert.equal(SEND_FEEDBACK_TOOL_NAME, "send_feedback");
  // The earlier identifier keeps compiling and holds the new name.
  assert.equal(REQUEST_CAPABILITY_TOOL_NAME, SEND_FEEDBACK_TOOL_NAME);
  assert.equal(LEGACY_REQUEST_CAPABILITY_TOOL_NAME, "request_capability");
  assert.deepEqual(REQUEST_CAPABILITY_ANNOTATIONS, {
    title: "Send feedback",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
});

test("send_feedback is off without a delivery path or when analytics is disabled", () => {
  // No ingest sink configured -> nothing to deliver, so nothing is injected.
  assert.equal(createAnalyticsRecorder().hasTool(SEND_FEEDBACK_TOOL_NAME), false);
  for (const setting of [...EXPLICIT, ...DEFAULT_ON]) {
    assert.equal(
      createAnalyticsRecorder({ armature: { ...setting, apiKey: "" } }).hasTool(SEND_FEEDBACK_TOOL_NAME),
      false,
    );
    // Analytics explicitly disabled.
    assert.equal(
      createAnalyticsRecorder({
        armature: { ...setting, enabled: false, emit: () => undefined },
      }).hasTool(SEND_FEEDBACK_TOOL_NAME),
      false,
    );
  }
});

test("send_feedback is on by default once a delivery path is configured, with no alias tool", () => {
  for (const delivery of [{ emit: () => undefined }, { apiKey: "ak_test" }]) {
    const recorder = createAnalyticsRecorder({ armature: delivery });
    assert.equal(recorder.hasTool(SEND_FEEDBACK_TOOL_NAME), true);
    // The SDK registers only send_feedback, never the old name.
    assert.equal(recorder.hasTool(LEGACY_REQUEST_CAPABILITY_TOOL_NAME), false);
    assert.deepEqual(recorder.toolDefinitions().map((definition) => definition.name), [SEND_FEEDBACK_TOOL_NAME]);
  }
});

test("send_feedback is disabled by sendFeedback: false and by the old requestCapability: false", () => {
  for (const setting of DISABLED) {
    const recorder = createAnalyticsRecorder({ armature: { ...setting, emit: () => undefined } });
    assert.equal(recorder.hasTool(SEND_FEEDBACK_TOOL_NAME), false, JSON.stringify(setting));
    assert.deepEqual(recorder.toolDefinitions(), []);
  }
});

test("sendFeedback wins over requestCapability when both are set", () => {
  // New key true, old key false: on, and explicitly so (the name is reserved).
  const on = createAnalyticsRecorder({
    armature: { emit: () => undefined, sendFeedback: true, requestCapability: false },
  });
  assert.equal(on.hasTool(SEND_FEEDBACK_TOOL_NAME), true);
  assert.throws(
    () => on.tool({ name: SEND_FEEDBACK_TOOL_NAME }, async () => ({ content: [] })),
    RESERVED_ERROR,
  );
  // New key false, old key true: off, so the customer's tool is just a tool.
  const off = createAnalyticsRecorder({
    armature: { emit: () => undefined, sendFeedback: false, requestCapability: true },
  });
  assert.equal(off.hasTool(SEND_FEEDBACK_TOOL_NAME), false);
  assert.doesNotThrow(
    () => off.tool({ name: SEND_FEEDBACK_TOOL_NAME }, async () => ({ content: [] })),
  );
  // An unset new key falls back to the old one.
  assert.equal(
    createAnalyticsRecorder({ armature: { emit: () => undefined, sendFeedback: undefined, requestCapability: false } })
      .hasTool(SEND_FEEDBACK_TOOL_NAME),
    false,
  );
});

test("default-on send_feedback yields to a customer send_feedback tool in the recorder", async () => {
  for (const setting of DEFAULT_ON) {
    const { batches, emit } = collectBatches();
    const recorder = createAnalyticsRecorder({
      armature: { ...setting, delivery: "await", actorId: "feedback-yield", emit },
    });
    assert.equal(recorder.hasTool(SEND_FEEDBACK_TOOL_NAME), true);
    const received: unknown[] = [];
    assert.doesNotThrow(() => recorder.tool(
      {
        name: SEND_FEEDBACK_TOOL_NAME,
        description: "Ask for a tool.",
        inputSchema: { type: "object", properties: { note: { type: "string" } } },
      },
      async (args) => {
        received.push(args);
        return { content: [{ type: "text", text: "customer" }] };
      },
    ));
    // The customer's tool replaces the SDK's: one definition, theirs.
    const definitions = recorder.toolDefinitions();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0]?.description, "Ask for a tool.");
    assert.notDeepEqual(definitions[0]?.annotations, REQUEST_CAPABILITY_ANNOTATIONS);

    const result = await recorder.dispatch<{ content: { text: string }[] }>(
      SEND_FEEDBACK_TOOL_NAME,
      { note: "hello" },
    );
    assert.equal(result.content[0]?.text, "customer");
    assert.deepEqual(received, [{ note: "hello" }]);
    // A customer tool is a customer tool: no capability_request marker.
    assert.equal(feedbackEvents(batches)[0]?.metadata.capability_request, undefined);
  }
});

test("a customer send_feedback tool registers normally while the SDK tool is disabled", () => {
  for (const setting of DISABLED) {
    const recorder = createAnalyticsRecorder({ armature: { ...setting, emit: () => undefined } });
    assert.doesNotThrow(() => recorder.tool(
      { name: SEND_FEEDBACK_TOOL_NAME, description: "Ask for a tool." },
      async () => ({ content: [{ type: "text", text: "customer" }] }),
    ));
    const definitions = recorder.toolDefinitions();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0]?.description, "Ask for a tool.");
  }
});

test("explicitly enabled send_feedback reserves its name in the recorder", () => {
  for (const setting of EXPLICIT) {
    const recorder = createAnalyticsRecorder({ armature: { ...setting, emit: () => undefined } });
    assert.throws(
      () => recorder.tool({ name: SEND_FEEDBACK_TOOL_NAME }, async () => ({ content: [] })),
      RESERVED_ERROR,
      JSON.stringify(setting),
    );
    // The old name is not reserved: the SDK no longer uses it.
    assert.doesNotThrow(
      () => recorder.tool({ name: LEGACY_REQUEST_CAPABILITY_TOOL_NAME }, async () => ({ content: [] })),
    );
  }
});

test("recorder injects send_feedback and records a call as tool_name send_feedback with capability_request", async () => {
  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "feedback-recorder",
      emit,
    },
  });

  const definitions = recorder.toolDefinitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.name, SEND_FEEDBACK_TOOL_NAME);
  assert.equal(definitions[0]?.description, REQUEST_CAPABILITY_DESCRIPTION);
  assert.deepEqual(definitions[0]?.annotations, {
    title: "Send feedback",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  const schema = definitions[0]?.inputSchema as JsonObjectSchema;
  assert.deepEqual(schema.required, ["capability"]);
  assert.equal(schema.properties?.telemetry, undefined);
  assert.equal(
    (schema.properties?.capability as { minLength?: number } | undefined)?.minLength,
    1,
  );
  assert.equal(
    (schema.properties?.capability as { maxLength?: number } | undefined)?.maxLength,
    1000,
  );
  assert.equal(
    (schema.properties?.capability as { description?: string } | undefined)?.description,
    "One English sentence describing the missing capability needed for the user's task. Translate the summary into English even when the user writes in another language. Describe generic actions and roles. Omit names, contacts, IDs, credentials and all tool argument values.",
  );

  const result = await recorder.dispatch<{ content: { text: string }[] }>(
    SEND_FEEDBACK_TOOL_NAME,
    { capability: "Export invoices to CSV" },
    { sessionId: "feedback-session" },
  );
  assert.equal(result.content[0]?.text, "Capability request acknowledged.");

  const [event] = feedbackEvents(batches);
  assert.equal(event?.kind, "tool_call");
  assert.equal(event?.metadata.tool_name, SEND_FEEDBACK_TOOL_NAME);
  assert.equal(event?.metadata.capability_request, true);
  assert.deepEqual(JSON.parse(event?.metadata.input_preview as string), {
    capability: "Export invoices to CSV",
  });

  // Validation is unchanged.
  const invalid = await recorder.dispatch<{ isError?: boolean; content: { text: string }[] }>(
    SEND_FEEDBACK_TOOL_NAME,
    { capability: "  " },
  );
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content[0]?.text, "capability must be a non-empty string");
  // There is no tool under the old name.
  await assert.rejects(() => recorder.dispatch(LEGACY_REQUEST_CAPABILITY_TOOL_NAME, { capability: "x" }));
});

test("withMcpAnalytics: a non-McpServer factory result is an error only when send_feedback is explicit", () => {
  for (const setting of EXPLICIT) {
    assert.throws(
      () => withMcpAnalytics(
        { armature: { ...setting, emit: () => undefined } },
        () => ({ notAnMcpServer: true }),
      ),
      SHAPE_ERROR,
      JSON.stringify(setting),
    );
  }
  // On by default, an incompatible factory result skips injection quietly;
  // disabled, there is nothing to inject.
  for (const setting of [...DEFAULT_ON, ...DISABLED]) {
    assert.doesNotThrow(
      () => withMcpAnalytics(
        { armature: { ...setting, emit: () => undefined } },
        () => ({ notAnMcpServer: true }),
      ),
    );
  }
});

const listTools = async (server: McpServer) => {
  const client = new Client({ name: "hint-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
};

const listDescription = async (server: McpServer, name: string) =>
  (await listTools(server)).find((tool) => tool.name === name)?.description;

const serverWithOwnFeedbackTool = () => {
  const server = new McpServer({ name: "own-feedback", version: "0.0.1" });
  server.registerTool(SEND_FEEDBACK_TOOL_NAME, { description: "Ask for a tool." }, async () => ({
    content: [{ type: "text" as const, text: "noted by the customer" }],
  }));
  return server;
};

test("withMcpAnalytics: explicit send_feedback plus a customer send_feedback tool is an error", () => {
  for (const setting of EXPLICIT) {
    assert.throws(
      () => withMcpAnalytics({ armature: { ...setting, emit: () => undefined } }, serverWithOwnFeedbackTool),
      RESERVED_ERROR,
      JSON.stringify(setting),
    );
  }
});

test("withMcpAnalytics: default-on send_feedback yields to the customer's send_feedback tool", async () => {
  for (const setting of [...DEFAULT_ON, ...DISABLED]) {
    const { result: server } = withMcpAnalytics(
      { armature: { ...setting, emit: () => undefined } },
      serverWithOwnFeedbackTool,
    );
    const client = new Client({ name: "yield-client", version: "0.0.1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), [SEND_FEEDBACK_TOOL_NAME]);
      assert.equal(tools[0]?.description, "Ask for a tool.");
      const result = await client.callTool({ name: SEND_FEEDBACK_TOOL_NAME, arguments: {} });
      assert.equal((result.content as { text: string }[])[0]?.text, "noted by the customer");
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("withMcpAnalytics never adds text to tool descriptions, whether or not send_feedback is listed", async () => {
  const register = (server: McpServer) =>
    server.registerTool("lookup", { description: "Look up an order." }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
  const config = { armature: { emit: () => undefined } };

  // On by default: the factory's McpServer lists send_feedback; lookup is
  // listed exactly as registered.
  const { result: attached } = withMcpAnalytics(config, () => {
    const server = new McpServer({ name: "attached", version: "0.0.1" });
    register(server);
    return server;
  });
  const attachedTools = await listTools(attached);
  assert.deepEqual(attachedTools.map((tool) => tool.name).sort(), ["lookup", SEND_FEEDBACK_TOOL_NAME]);
  assert.equal(attachedTools.find((tool) => tool.name === "lookup")?.description, "Look up an order.");

  // A wrapped server is skipped quietly: including a registration the factory
  // scheduled after returning, it lists no SDK tool and no hint.
  let inner: McpServer | undefined;
  let scheduled: Promise<void> | undefined;
  withMcpAnalytics(config, () => {
    inner = new McpServer({ name: "wrapped", version: "0.0.1" });
    register(inner);
    scheduled = new Promise((resolve) => {
      setImmediate(() => {
        inner!.registerTool("track", { description: "Track a parcel." }, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
        resolve();
      });
    });
    return { server: inner };
  });
  await scheduled;
  assert.ok(inner);
  const innerTools = await listTools(inner);
  assert.deepEqual(innerTools.map((tool) => tool.name).sort(), ["lookup", "track"]);
  assert.equal(innerTools.find((tool) => tool.name === "lookup")?.description, "Look up an order.");
  assert.equal(innerTools.find((tool) => tool.name === "track")?.description, "Track a parcel.");
});

test("withMcpAnalytics keeps a description the factory updated after registration", async () => {
  let server: McpServer | undefined;
  withMcpAnalytics({ armature: { emit: () => undefined } }, () => {
    server = new McpServer({ name: "updated", version: "0.0.1" });
    const lookup = server.registerTool("lookup", { description: "Look up orders." }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    lookup.update({ description: "Look up paid orders." });
    return { server };
  });
  assert.ok(server);
  assert.equal(await listDescription(server, "lookup"), "Look up paid orders.");
});

test("withMcpAnalytics registers a description-less tool without a description", async () => {
  let server: McpServer | undefined;
  let registeredDescription: string | undefined = "unset";
  withMcpAnalytics({ armature: { emit: () => undefined } }, () => {
    server = new McpServer({ name: "no-description", version: "0.0.1" });
    const lookup = server.registerTool("lookup", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    registeredDescription = lookup.description;
    return { server };
  });
  assert.ok(server);
  assert.equal(registeredDescription, undefined);
  assert.equal(await listDescription(server, "lookup"), undefined);
});

test("withMcpAnalytics removes an old SDK hint a cached description still carries", async () => {
  let server: McpServer | undefined;
  withMcpAnalytics({ armature: { emit: () => undefined } }, () => {
    server = new McpServer({ name: "cached-hint", version: "0.0.1" });
    server.registerTool("lookup", { description: `Look up orders.${OLD_FULL_HINT_SUFFIX}` }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    server.tool("track", `Track a parcel.${OLD_HINT_SUFFIX}`, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    return { server };
  });
  assert.ok(server);
  const tools = await listTools(server);
  assert.equal(tools.find((tool) => tool.name === "lookup")?.description, "Look up orders.");
  assert.equal(tools.find((tool) => tool.name === "track")?.description, "Track a parcel.");
});

test("customer prose that quotes the old SDK hint is kept, also after a factory update", async () => {
  const guide = `Guide:\n\n${OLD_FULL_HINT}\n\nEnd of guide.`;
  const note = "\n\nFactory note.";
  assert.equal(stripSdkDescriptionHint(guide), guide);
  // The old hint followed by more text is customer prose, not an SDK suffix.
  assert.equal(stripSdkDescriptionHint(`Look up orders.${OLD_FULL_HINT_SUFFIX}${note}`), `Look up orders.${OLD_FULL_HINT_SUFFIX}${note}`);

  let server: McpServer | undefined;
  withMcpAnalytics({ armature: { emit: () => undefined } }, () => {
    server = new McpServer({ name: "quoted-paragraph", version: "0.0.1" });
    const lookup = server.registerTool("lookup", { description: guide }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    lookup.update({ description: `${lookup.description}${note}` });
    return { server };
  });
  assert.ok(server);
  assert.equal(await listDescription(server, "lookup"), `${guide}${note}`);
});

test("withMcpAnalytics passes a description past MAX_TOOL_DESCRIPTION_LENGTH through unchanged", async () => {
  const long = `${"a".repeat(MAX_TOOL_DESCRIPTION_LENGTH)} ${"b".repeat(20)}`;
  let server: McpServer | undefined;
  withMcpAnalytics({ armature: { emit: () => undefined, sendFeedback: true } }, () => {
    server = new McpServer({ name: "near-limit", version: "0.0.1" });
    server.registerTool("lookup", { description: long }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    return server;
  });
  assert.ok(server);
  assert.equal(await listDescription(server, "lookup"), long);
});

test("Mastra low-level wrapper follows the recorder for send_feedback", () => {
  // The recorder is the source of truth: it has the tool (on by default with a
  // sink), so the wrapper injects it even when the lean wrap-time config omits
  // the delivery sink instead of throwing a mismatch error.
  const recorder = createAnalyticsRecorder({
    armature: { emit: () => undefined },
  });
  // The return type honestly includes an optional send_feedback key, so it
  // can be read without a cast.
  const wrapped = wrapMastraToolsWithRecorder({}, recorder, { armature: { apiKey: "" } });
  assert.ok(wrapped[SEND_FEEDBACK_TOOL_NAME]);
  assert.equal(Object.hasOwn(wrapped, LEGACY_REQUEST_CAPABILITY_TOOL_NAME), false);

  // A recorder without the tool never injects it, whatever the wrap-time
  // config says.
  for (const setting of DISABLED) {
    const off = createAnalyticsRecorder({ armature: { ...setting, emit: () => undefined } });
    const wrappedOff = wrapMastraToolsWithRecorder({}, off, { armature: { sendFeedback: true } });
    assert.equal(wrappedOff[SEND_FEEDBACK_TOOL_NAME], undefined);
  }
});

test("attached McpServer advertises the exact send_feedback contract and records its calls", async () => {
  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "feedback-attached",
      emit,
    },
  });
  const server = recorder.createMcpServer({ name: "feedback-server", version: "0.0.1" });
  const client = new Client({ name: "feedback-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    // Only the new name; no alias tool under request_capability.
    assert.deepEqual(listed.tools.map(({ name }) => name), [SEND_FEEDBACK_TOOL_NAME]);
    const tool = listed.tools[0];
    assert.ok(tool);
    assert.equal(tool.description, REQUEST_CAPABILITY_DESCRIPTION);
    assert.equal(tool.inputSchema.properties?.telemetry, undefined);
    // ChatGPT's app directory requires these three booleans explicitly.
    assert.deepEqual(tool.annotations, {
      title: "Send feedback",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });

    const result = await client.callTool({
      name: SEND_FEEDBACK_TOOL_NAME,
      arguments: { capability: "Send a fax" },
    });
    assert.equal((result.content as { text: string }[])[0]?.text, "Capability request acknowledged.");
    const [event] = feedbackEvents(batches);
    assert.equal(event?.metadata.tool_name, SEND_FEEDBACK_TOOL_NAME);
    assert.equal(event?.metadata.capability_request, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("withMcpAnalytics injects send_feedback into factory-created servers by default", async () => {
  for (const setting of [...DEFAULT_ON, ...EXPLICIT]) {
    const { batches, emit } = collectBatches();
    const { result: server } = withMcpAnalytics(
      {
        armature: {
          ...setting,
          delivery: "await",
          actorId: "feedback-factory",
          emit,
        },
      },
      () => new McpServer({ name: "factory-server", version: "0.0.1" }),
    );
    const client = new Client({ name: "factory-client", version: "0.0.1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(({ name }) => name), [SEND_FEEDBACK_TOOL_NAME]);
      assert.equal(listed.tools[0]?.description, REQUEST_CAPABILITY_DESCRIPTION);
      assert.equal(listed.tools[0]?.annotations?.title, "Send feedback");
      await client.callTool({
        name: SEND_FEEDBACK_TOOL_NAME,
        arguments: { capability: "Generate a PDF" },
      });
      const [event] = feedbackEvents(batches);
      assert.equal(event?.metadata.tool_name, SEND_FEEDBACK_TOOL_NAME);
      assert.equal(event?.metadata.capability_request, true);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("withMcpAnalytics lists no send_feedback when either key disables it", async () => {
  for (const setting of DISABLED) {
    const { result: server } = withMcpAnalytics(
      { armature: { ...setting, emit: () => undefined } },
      () => {
        const s = new McpServer({ name: "disabled-server", version: "0.0.1" });
        s.registerTool("lookup", { description: "Look up an order." }, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
        return s;
      },
    );
    const tools = await listTools(server);
    assert.deepEqual(tools.map((tool) => tool.name), ["lookup"], JSON.stringify(setting));
    assert.equal(tools[0]?.description, "Look up an order.");
  }
});

test("Mastra adapter injects send_feedback by default and records its calls", async () => {
  const { batches, emit } = collectBatches();
  const tools = wrapMastraTools({}, {
    armature: {
      delivery: "await",
      actorId: "feedback-mastra",
      emit,
    },
  }) as Record<string, {
    description?: string;
    execute?: (input: unknown, context?: unknown) => Promise<unknown>;
  }>;

  assert.deepEqual(Object.keys(tools), [SEND_FEEDBACK_TOOL_NAME]);
  const tool = tools[SEND_FEEDBACK_TOOL_NAME];
  assert.equal(tool?.description, REQUEST_CAPABILITY_DESCRIPTION);
  const result = await tool?.execute?.(
    { capability: "Transcribe a call" },
    { mcp: { extra: { sessionId: "mastra-feedback" } } },
  );
  assert.equal(result, "Capability request acknowledged.");
  const [event] = feedbackEvents(batches);
  assert.equal(event?.metadata.tool_name, SEND_FEEDBACK_TOOL_NAME);
  assert.equal(event?.metadata.capability_request, true);
});

test("Mastra adapter: disabled by either key, yields to a customer tool by default, rejects a collision when explicit", () => {
  const customerTool = {
    id: SEND_FEEDBACK_TOOL_NAME,
    description: "Ask for a tool.",
    execute: async () => "noted",
  };
  for (const setting of DISABLED) {
    assert.equal(
      wrapMastraTools({}, { armature: { ...setting, emit: () => undefined } })[SEND_FEEDBACK_TOOL_NAME],
      undefined,
    );
  }
  // On by default (or off), the customer's own tool is kept and wrapped.
  for (const setting of [...DEFAULT_ON, ...DISABLED]) {
    const wrapped = wrapMastraTools(
      { send_feedback: customerTool },
      { armature: { ...setting, emit: () => undefined } },
    );
    assert.deepEqual(Object.keys(wrapped), [SEND_FEEDBACK_TOOL_NAME]);
    assert.equal(wrapped.send_feedback?.description, "Ask for a tool.");
    assert.notEqual(wrapped.send_feedback?.execute, customerTool.execute);
    // Matching on the tool id, under another key, also yields.
    const byId = wrapMastraTools({ ask: customerTool }, { armature: { ...setting, emit: () => undefined } });
    assert.deepEqual(Object.keys(byId), ["ask"]);
  }
  for (const setting of EXPLICIT) {
    assert.throws(
      () => wrapMastraTools({ send_feedback: customerTool }, { armature: { ...setting, emit: () => undefined } }),
      RESERVED_ERROR,
      JSON.stringify(setting),
    );
    assert.throws(
      () => wrapMastraTools({ ask: customerTool }, { armature: { ...setting, emit: () => undefined } }),
      RESERVED_ERROR,
    );
  }
});

test("no tool description mentions send_feedback, whether or not the SDK lists it", () => {
  const definition = {
    name: "lookup_customer",
    description: "Look up a customer.",
    inputSchema: { type: "object", properties: {} },
  };
  for (const setting of [...DEFAULT_ON, ...EXPLICIT, ...DISABLED]) {
    const decorated = createAnalyticsRecorder({
      armature: { ...setting, emit: () => undefined },
    }).decorateDefinitions([definition])[0];
    assert.equal(decorated?.description, "Look up a customer.");
    assertNoSdkHint(decorated?.description);
  }
});

test("appendTelemetryHint is a deprecated alias that appends nothing and ignores its options", () => {
  const withNew = `Look up a customer.${OLD_FULL_HINT_SUFFIX}`;
  const withOld = `Look up a customer.${OLD_HINT_SUFFIX}`;
  for (const options of [
    {},
    { requestCapability: true },
    { requestCapability: false },
    { requestCapability: true, toolName: "lookup_customer", logLevel: "warning" as const },
  ]) {
    assert.equal(appendTelemetryHint("Look up a customer.", options), "Look up a customer.");
    assert.equal(appendTelemetryHint(withNew, options), "Look up a customer.");
    assert.equal(appendTelemetryHint(withOld, options), "Look up a customer.");
    assert.equal(appendTelemetryHint(undefined, options), undefined);
    assert.equal(appendTelemetryHint("", options), "");
  }
  assert.equal(appendTelemetryHint(OLD_FULL_HINT, { requestCapability: true }), "");
});

test("old SDK suffixes are removed without changing customer prose", () => {
  for (const hint of OLD_SDK_HINTS) {
    const stripped = stripSdkDescriptionHint(`Customer text.\n\n${hint}`);
    assert.equal(stripped, "Customer text.");
    assertNoSdkHint(stripped);
    // Trailing whitespace after the suffix does not hide it.
    assert.equal(stripSdkDescriptionHint(`Customer text.\n\n${hint}\n `), "Customer text.");
    // A description that was only an SDK hint becomes empty.
    assert.equal(stripSdkDescriptionHint(hint), "");
    // A sentence quoted inside customer prose is not an SDK suffix.
    const prose = `The previous instruction was: ${hint} This is customer documentation.`;
    assert.equal(stripSdkDescriptionHint(prose), prose);
    // Only a separate trailing paragraph counts; a same-line ending stays.
    assert.equal(stripSdkDescriptionHint(`Customer text. ${hint}`), `Customer text. ${hint}`);
  }
  // Customer text that merely asks for request_capability is left as written.
  const asks = `Look up a customer. ${OLD_REQUEST_CAPABILITY_SENTENCE}`;
  assert.equal(stripSdkDescriptionHint(asks), asks);
  assert.equal(stripSdkDescriptionHint(`Look up a customer.\n\n${OLD_REQUEST_CAPABILITY_SENTENCE}`), `Look up a customer.\n\n${OLD_REQUEST_CAPABILITY_SENTENCE}`);

  const longBase = "é".repeat(500);
  assert.equal(stripSdkDescriptionHint(`${longBase}\n\n${OLD_SDK_HINTS[5]}`), longBase);
  // Stacked suffixes from successive older wrappers all come off.
  assert.equal(
    stripSdkDescriptionHint(`Customer text.\n\n${OLD_SDK_HINTS[5]}\n\n${OLD_SDK_HINTS[4]}`),
    "Customer text.",
  );
  assert.equal(
    stripSdkDescriptionHint(`Customer text.\n\n${OLD_SDK_HINTS.join("\n\n")}`),
    "Customer text.",
  );
  assert.equal(stripSdkDescriptionHint(OLD_SDK_HINTS.join("\n\n")), "");
  // Whitespace that belongs to the customer text before the suffix is kept.
  assert.equal(stripSdkDescriptionHint(`Customer text.  \n\n${OLD_SDK_HINTS[5]}`), "Customer text.  ");
  assert.equal(stripSdkDescriptionHint(undefined), undefined);
  assert.equal(stripSdkDescriptionHint(""), "");
});

test("McpServer tools/list carries send_feedback by default without mentioning it elsewhere", async () => {
  const { result: server } = withMcpAnalytics(
    { armature: { emit: () => undefined } },
    () => {
      const s = new McpServer({ name: "hint-server", version: "0.0.1" });
      s.registerTool(
        "lookup_customer",
        { description: "Look up a customer." },
        async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      );
      return s;
    },
  );
  const tools = await listTools(server);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const lookup = byName.get("lookup_customer");
  assert.equal(lookup?.description, "Look up a customer.");
  assertNoSdkHint(lookup?.description);
  // Telemetry is advertised in the schema, with only the public fields.
  const telemetry = lookup?.inputSchema.properties?.telemetry as JsonObjectSchema | undefined;
  assert.deepEqual(Object.keys(telemetry?.properties ?? {}), ["user_intent", "call_purpose"]);
  // The SDK-owned tool itself stays undecorated.
  assert.equal(
    byName.get(SEND_FEEDBACK_TOOL_NAME)?.description,
    REQUEST_CAPABILITY_DESCRIPTION,
  );
  assert.equal(byName.has(LEGACY_REQUEST_CAPABILITY_TOOL_NAME), false);
});

test("descriptions of any length pass through unchanged", () => {
  const recorder = createAnalyticsRecorder({
    armature: { emit: () => undefined },
  });
  for (const description of [
    "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH - 1),
    "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH),
    "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 1),
    "a".repeat(4 * MAX_TOOL_DESCRIPTION_LENGTH),
    // "é" is one character but two UTF-8 bytes.
    "é".repeat(MAX_TOOL_DESCRIPTION_LENGTH),
  ]) {
    assert.equal(stripSdkDescriptionHint(description), description);
    const [decorated] = recorder.decorateDefinitions([
      { name: "long_tool", description, inputSchema: { type: "object", properties: {} } },
    ]);
    assert.equal(decorated?.description, description);
  }
});

test("removing SDK suffixes is idempotent and never grows a description", () => {
  for (const length of [10, 900, 950, 1000, 1100]) {
    const base = "a".repeat(length);
    for (const input of [base, `${base}${OLD_HINT_SUFFIX}`, `${base}${OLD_FULL_HINT_SUFFIX}`]) {
      const once = stripSdkDescriptionHint(input);
      assert.equal(once, base);
      assert.equal(stripSdkDescriptionHint(once), once);
      assert.ok((once ?? "").length <= input.length);
    }
  }
});

test("descriptionLengthLogLevel is accepted and ignored: no description notice at any level", () => {
  const seen: Array<[string, string]> = [];
  const original = { debug: console.debug, info: console.info, log: console.log, warn: console.warn };
  const originalWrite = process.stderr.write;
  console.debug = (message?: unknown) => { seen.push(["console.debug", String(message)]); };
  console.info = (message?: unknown) => { seen.push(["console.info", String(message)]); };
  console.log = (message?: unknown) => { seen.push(["console.log", String(message)]); };
  console.warn = (message?: unknown) => { seen.push(["console.warn", String(message)]); };
  process.stderr.write = ((chunk: unknown) => {
    seen.push(["stderr", String(chunk)]);
    return true;
  }) as typeof process.stderr.write;
  try {
    for (const level of ["debug", "info", "warning", "none", undefined] as const) {
      const recorder = createAnalyticsRecorder({
        armature: { emit: () => undefined, descriptionLengthLogLevel: level },
      });
      const tool = {
        name: `long_tool_${level ?? "default"}`,
        description: "z".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 10),
        inputSchema: { type: "object", properties: {} },
      };
      const [decorated] = recorder.decorateDefinitions([tool]);
      recorder.decorateDefinitions([tool]);
      assert.equal(decorated?.description, tool.description);
      assert.ok(
        (decorated?.inputSchema as JsonObjectSchema).properties?.telemetry,
        "telemetry is still advertised",
      );
    }
    assert.deepEqual(seen, []);
  } finally {
    Object.assign(console, original);
    process.stderr.write = originalWrite;
  }
});

test("Mastra tools never mention send_feedback, even when the recorder lists it", () => {
  const recorder = createAnalyticsRecorder({
    armature: { emit: () => undefined },
  });
  const wrapped = wrapMastraToolsWithRecorder(
    {
      lookup_customer: {
        id: "lookup_customer",
        description: "Look up a customer.",
        execute: async () => "ok",
      },
      track_parcel: {
        id: "track_parcel",
        description: `Track a parcel.${OLD_FULL_HINT_SUFFIX}`,
        execute: async () => "ok",
      },
    },
    recorder,
    { armature: { apiKey: "" } },
  );
  assert.ok(wrapped[SEND_FEEDBACK_TOOL_NAME]);
  assert.equal(wrapped.lookup_customer?.description, "Look up a customer.");
  assert.equal(wrapped.track_parcel?.description, "Track a parcel.");
  assertNoSdkHint(wrapped.lookup_customer?.description);
  assertNoSdkHint(wrapped.track_parcel?.description);
});
