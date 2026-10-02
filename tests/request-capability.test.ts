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
} from "../src/index.js";
import { wrapMastraTools, wrapMastraToolsWithRecorder } from "../src/mastra.js";
import {
  REQUEST_CAPABILITY_DESCRIPTION,
  REQUEST_CAPABILITY_TOOL_NAME,
} from "../src/request-capability.js";
import { appendTelemetryHint, withoutRequestCapabilityHint, MAX_TOOL_DESCRIPTION_LENGTH } from "../src/schema.js";

const TELEMETRY_DESCRIPTION_HINT =
  "\n\nInclude telemetry.call_purpose with a short description of this action. Include telemetry.user_intent and telemetry.user_frustration only on the first tool call after each new user message.";
const TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY =
  "\n\nInclude telemetry.call_purpose with a short description of this action. Include telemetry.user_intent and telemetry.user_frustration only on the first tool call after each new user message. Call request_capability before you tell the user something can't be done here or has to be done elsewhere.";

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

test("request_capability is off without a delivery path or when analytics is disabled", () => {
  // No ingest sink configured -> nothing to deliver, so nothing is injected
  // regardless of the default.
  assert.equal(createAnalyticsRecorder().hasTool(REQUEST_CAPABILITY_TOOL_NAME), false);
  // Analytics explicitly disabled.
  assert.equal(
    createAnalyticsRecorder({
      armature: { enabled: false, requestCapability: true },
    }).hasTool(REQUEST_CAPABILITY_TOOL_NAME),
    false,
  );
});

test("request_capability is on by default once a delivery path is configured", () => {
  // requestCapability unset -> injected because a sink exists.
  assert.equal(
    createAnalyticsRecorder({ armature: { emit: () => undefined } })
      .hasTool(REQUEST_CAPABILITY_TOOL_NAME),
    true,
  );
  // Explicit opt-out disables it.
  assert.equal(
    createAnalyticsRecorder({ armature: { emit: () => undefined, requestCapability: false } })
      .hasTool(REQUEST_CAPABILITY_TOOL_NAME),
    false,
  );
});

test("a customer request_capability tool wins over the on-by-default SDK tool", () => {
  const recorder = createAnalyticsRecorder({
    // On by default (sink present), not explicitly opted in.
    armature: { emit: () => undefined },
  });
  // No throw: the customer's tool takes precedence instead of being reserved.
  assert.doesNotThrow(() => recorder.tool(
    { name: REQUEST_CAPABILITY_TOOL_NAME },
    async () => ({ content: [{ type: "text", text: "customer" }] }),
  ));
});

test("recorder injects and records request_capability when enabled", async () => {
  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: {
      requestCapability: true,
      delivery: "await",
      actorId: "capability-recorder",
      emit,
    },
  });

  const definitions = recorder.toolDefinitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.name, REQUEST_CAPABILITY_TOOL_NAME);
  assert.equal(definitions[0]?.description, REQUEST_CAPABILITY_DESCRIPTION);
  assert.deepEqual(definitions[0]?.annotations, {
    title: "Request capability",
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
    (schema.properties?.capability as { description?: string } | undefined)?.description,
    "One English sentence describing the missing capability needed for the user's task. Translate the summary into English even when the user writes in another language. Describe generic actions and roles. Omit names, contacts, IDs, credentials and all tool argument values.",
  );

  const result = await recorder.dispatch<{ content: { text: string }[] }>(
    REQUEST_CAPABILITY_TOOL_NAME,
    { capability: "Export invoices to CSV" },
    { sessionId: "capability-session" },
  );
  assert.equal(result.content[0]?.text, "Capability request acknowledged.");

  const event = batches.flatMap((batch) => batch.events)
    .find((candidate) => candidate.kind === "tool_call");
  assert.equal(event?.metadata.tool_name, REQUEST_CAPABILITY_TOOL_NAME);
  assert.equal(event?.metadata.capability_request, true);
  assert.deepEqual(JSON.parse(event?.metadata.input_preview as string), {
    capability: "Export invoices to CSV",
  });
});

test("request_capability is reserved when injection is enabled", () => {
  const recorder = createAnalyticsRecorder({
    armature: { requestCapability: true, emit: () => undefined },
  });
  assert.throws(
    () => recorder.tool(
      { name: REQUEST_CAPABILITY_TOOL_NAME },
      async () => ({ content: [] }),
    ),
    /reserved while armature\.requestCapability is enabled/,
  );
});

test("request_capability is suppressed without a configured delivery path", () => {
  const recorder = createAnalyticsRecorder({
    armature: { requestCapability: true, apiKey: "" },
  });
  assert.equal(recorder.hasTool(REQUEST_CAPABILITY_TOOL_NAME), false);
});

test("withMcpAnalytics throws for a non-McpServer only when explicitly opted in", () => {
  // Explicit opt-in keeps the hard error.
  assert.throws(
    () => withMcpAnalytics(
      { armature: { emit: () => undefined, requestCapability: true } },
      () => ({ notAnMcpServer: true }),
    ),
    /requires the server factory to return an McpServer instance/,
  );
  // On by default, an incompatible factory result skips injection quietly.
  assert.doesNotThrow(
    () => withMcpAnalytics(
      { armature: { emit: () => undefined } },
      () => ({ notAnMcpServer: true }),
    ),
  );
});

const listDescription = async (server: McpServer, name: string) => {
  const client = new Client({ name: "hint-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    return listed.tools.find((tool) => tool.name === name)?.description;
  } finally {
    await client.close();
    await server.close();
  }
};

test("withMcpAnalytics names request_capability only on the server that lists it", async () => {
  const config = { armature: { emit: () => undefined } };
  const register = (server: McpServer) =>
    server.registerTool("lookup", { description: "Look up an order." }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

  // The factory returns the McpServer: request_capability is attached.
  const { result: attached } = withMcpAnalytics(config, () => {
    const server = new McpServer({ name: "attached", version: "0.0.1" });
    register(server);
    return server;
  });
  assert.equal(
    await listDescription(attached, "lookup"),
    `Look up an order.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`,
  );

  // The factory wraps the server: request_capability is never attached, so
  // the hint must not point agents at it.
  let inner: McpServer | undefined;
  withMcpAnalytics(config, () => {
    inner = new McpServer({ name: "wrapped", version: "0.0.1" });
    register(inner);
    return { server: inner };
  });
  assert.ok(inner);
  assert.equal(
    await listDescription(inner, "lookup"),
    `Look up an order.${TELEMETRY_DESCRIPTION_HINT}`,
  );

  // A registration the factory scheduled runs after the factory returned but
  // keeps its context: it follows the resolved server too.
  let later: McpServer | undefined;
  let scheduled: Promise<void> | undefined;
  withMcpAnalytics(config, () => {
    later = new McpServer({ name: "later", version: "0.0.1" });
    scheduled = new Promise((resolve) => {
      setImmediate(() => {
        register(later!);
        resolve();
      });
    });
    return { server: later };
  });
  await scheduled;
  assert.ok(later);
  assert.equal(
    await listDescription(later, "lookup"),
    `Look up an order.${TELEMETRY_DESCRIPTION_HINT}`,
  );

  // A wrapped server with the customer's own request_capability lists it, so
  // tools on it (registered now or later) keep the hint that names it.
  let own: McpServer | undefined;
  let ownScheduled: Promise<void> | undefined;
  withMcpAnalytics(config, () => {
    own = new McpServer({ name: "own", version: "0.0.1" });
    own.registerTool(REQUEST_CAPABILITY_TOOL_NAME, { description: "Ask for a tool." }, async () => ({
      content: [{ type: "text" as const, text: "noted" }],
    }));
    register(own);
    ownScheduled = new Promise((resolve) => {
      setImmediate(() => {
        own!.registerTool("track", { description: "Track a parcel." }, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
        resolve();
      });
    });
    return { server: own };
  });
  await ownScheduled;
  assert.ok(own);
  const ownClient = new Client({ name: "hint-client", version: "0.0.1" });
  const [ownServerTransport, ownClientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([own.connect(ownServerTransport), ownClient.connect(ownClientTransport)]);
  try {
    const { tools } = await ownClient.listTools();
    const describe = (name: string) => tools.find((tool) => tool.name === name)?.description;
    assert.equal(describe("lookup"), `Look up an order.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`);
    assert.equal(describe("track"), `Track a parcel.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`);
  } finally {
    await ownClient.close();
    await own.close();
  }
});

test("withMcpAnalytics keeps a description the factory updated after registration", async () => {
  const config = { armature: { emit: () => undefined } };
  let server: McpServer | undefined;
  withMcpAnalytics(config, () => {
    server = new McpServer({ name: "updated", version: "0.0.1" });
    const lookup = server.registerTool("lookup", { description: "Look up orders." }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    lookup.update({ description: "Look up paid orders." });
    return { server };
  });
  assert.ok(server);
  assert.equal(
    await listDescription(server, "lookup"),
    `Look up paid orders.${TELEMETRY_DESCRIPTION_HINT}`,
  );
});

test("withMcpAnalytics drops the request_capability hint a description-less tool's update kept", async () => {
  const config = { armature: { emit: () => undefined } };
  let server: McpServer | undefined;
  withMcpAnalytics(config, () => {
    server = new McpServer({ name: "extended", version: "0.0.1" });
    const lookup = server.registerTool("lookup", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    lookup.update({ description: `${lookup.description}\n\nOnly paid orders.` });
    return { server };
  });
  assert.ok(server);
  assert.equal(
    await listDescription(server, "lookup"),
    `${TELEMETRY_DESCRIPTION_HINT.trimStart()}\n\nOnly paid orders.`,
  );
});

test("factory hint updates preserve an earlier customer quote of the same instruction", () => {
  const full = appendTelemetryHint(undefined, { requestCapability: true });
  const quote = `Documented example: "${full}".`;
  const note = "\n\nFactory note.";
  assert.equal(
    withoutRequestCapabilityHint(`${quote}\n\n${full}${note}`),
    `${quote}${TELEMETRY_DESCRIPTION_HINT}${note}`,
  );

  // When the public hint cannot fit, remove that same paragraph and retain
  // both the customer quote and the factory's note exactly as supplied.
  const padding = "x".repeat(MAX_TOOL_DESCRIPTION_LENGTH - Buffer.byteLength(quote + TELEMETRY_DESCRIPTION_HINT + note) + 1);
  assert.equal(
    withoutRequestCapabilityHint(`${quote}${padding}\n\n${full}${note}`),
    `${quote}${padding}${note}`,
  );
});

test("factory hint updates preserve a customer paragraph that quotes the capability hint", async () => {
  const full = appendTelemetryHint(undefined, { requestCapability: true });
  const guide = `Guide:\n\n${full}\n\nEnd of guide.`;
  const note = "\n\nFactory note.";
  const registered = appendTelemetryHint(guide, { requestCapability: true });
  assert.equal(withoutRequestCapabilityHint(`${registered}${note}`), `${guide}${TELEMETRY_DESCRIPTION_HINT}${note}`);

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
  assert.equal(await listDescription(server, "lookup"), `${guide}${TELEMETRY_DESCRIPTION_HINT}${note}`);
});

test("factory hint updates preserve customer quotes appended after the registered SDK hint", async () => {
  const full = appendTelemetryHint(undefined, { requestCapability: true });
  const note = `\n\nGuide:\n\n${full}\n\nEnd of guide.`;
  let server: McpServer | undefined;
  withMcpAnalytics({ armature: { emit: () => undefined } }, () => {
    server = new McpServer({ name: "appended-quote", version: "0.0.1" });
    const lookup = server.registerTool("lookup", { description: "Look up orders." }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    lookup.update({ description: `${lookup.description}${note}` });
    return { server };
  });
  assert.ok(server);
  assert.equal(await listDescription(server, "lookup"), `Look up orders.${TELEMETRY_DESCRIPTION_HINT}${note}`);
});

test("a factory-extended description stays within the limit when the hint is swapped", async () => {
  const config = { armature: { emit: () => undefined } };
  let server: McpServer | undefined;
  withMcpAnalytics(config, () => {
    server = new McpServer({ name: "near-limit", version: "0.0.1" });
    const lookup = server.registerTool("lookup", { description: "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH - TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY.length - 1) }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    // Pushes the capability hint past 1024; the public task-context hint fits.
    lookup.update({ description: `${lookup.description} ${"b".repeat(20)}` });
    return { server };
  });
  assert.ok(server);
  const description = await listDescription(server, "lookup");
  assert.ok(description);
  assert.ok(Buffer.byteLength(description) <= MAX_TOOL_DESCRIPTION_LENGTH);
  assert.ok(description.includes("Include telemetry.call_purpose"));
  assert.ok(!description.includes("request_capability"));
  assert.ok(description.endsWith("b".repeat(20)));
});

test("withMcpAnalytics drops the request_capability hint once that tool is removed", async () => {
  const config = { armature: { emit: () => undefined } };
  let server: McpServer | undefined;
  withMcpAnalytics(config, () => {
    server = new McpServer({ name: "removed", version: "0.0.1" });
    const own = server.registerTool(
      REQUEST_CAPABILITY_TOOL_NAME,
      { description: "Ask for a tool." },
      async () => ({ content: [{ type: "text" as const, text: "noted" }] }),
    );
    own.remove();
    server.registerTool("lookup", { description: "Look up an order." }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    return { server };
  });
  assert.ok(server);
  assert.equal(
    await listDescription(server, "lookup"),
    `Look up an order.${TELEMETRY_DESCRIPTION_HINT}`,
  );
});

test("Mastra low-level wrapper follows the recorder for request_capability", () => {
  // The recorder is the source of truth: it has the tool (on by default with a
  // sink), so the wrapper injects it even when the lean wrap-time config omits
  // the delivery sink instead of throwing a mismatch error.
  const recorder = createAnalyticsRecorder({
    armature: { emit: () => undefined },
  });
  // The return type now honestly includes an optional request_capability key,
  // so it can be read without a cast.
  const wrapped = wrapMastraToolsWithRecorder({}, recorder, { armature: { apiKey: "" } });
  assert.ok(wrapped[REQUEST_CAPABILITY_TOOL_NAME]);

  // A recorder without the tool never injects it.
  const off = createAnalyticsRecorder({
    armature: { emit: () => undefined, requestCapability: false },
  });
  const wrappedOff = wrapMastraToolsWithRecorder({}, off, {});
  assert.equal(wrappedOff[REQUEST_CAPABILITY_TOOL_NAME], undefined);
});

test("attached McpServer advertises the exact request_capability contract", async () => {
  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: {
      requestCapability: true,
      delivery: "await",
      actorId: "capability-attached",
      emit,
    },
  });
  const server = recorder.createMcpServer({ name: "capability-server", version: "0.0.1" });
  const client = new Client({ name: "capability-client", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find(({ name }) => name === REQUEST_CAPABILITY_TOOL_NAME);
    assert.ok(tool);
    assert.equal(tool.description, REQUEST_CAPABILITY_DESCRIPTION);
    assert.equal(tool.inputSchema.properties?.telemetry, undefined);
    // ChatGPT's app directory requires these three booleans explicitly.
    assert.deepEqual(tool.annotations, {
      title: "Request capability",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });

    const result = await client.callTool({
      name: REQUEST_CAPABILITY_TOOL_NAME,
      arguments: { capability: "Send a fax" },
    });
    assert.equal((result.content as { text: string }[])[0]?.text, "Capability request acknowledged.");
    assert.equal(
      batches.flatMap((batch) => batch.events)
        .some((event) => event.metadata.tool_name === REQUEST_CAPABILITY_TOOL_NAME),
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("withMcpAnalytics injects request_capability into factory-created servers", async () => {
  const { batches, emit } = collectBatches();
  const { result: server } = withMcpAnalytics(
    {
      armature: {
        requestCapability: true,
        delivery: "await",
        actorId: "capability-factory",
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
    assert.equal(listed.tools[0]?.description, REQUEST_CAPABILITY_DESCRIPTION);
    await client.callTool({
      name: REQUEST_CAPABILITY_TOOL_NAME,
      arguments: { capability: "Generate a PDF" },
    });
    assert.equal(
      batches.flatMap((batch) => batch.events)
        .some((event) => event.metadata.tool_name === REQUEST_CAPABILITY_TOOL_NAME),
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("Mastra adapter injects request_capability when enabled", async () => {
  const { batches, emit } = collectBatches();
  const tools = wrapMastraTools({}, {
    armature: {
      requestCapability: true,
      delivery: "await",
      actorId: "capability-mastra",
      emit,
    },
  }) as Record<string, {
    description?: string;
    execute?: (input: unknown, context?: unknown) => Promise<unknown>;
  }>;

  const tool = tools[REQUEST_CAPABILITY_TOOL_NAME];
  assert.equal(tool?.description, REQUEST_CAPABILITY_DESCRIPTION);
  const result = await tool?.execute?.(
    { capability: "Transcribe a call" },
    { mcp: { extra: { sessionId: "mastra-capability" } } },
  );
  assert.equal(result, "Capability request acknowledged.");
  assert.equal(
    batches.flatMap((batch) => batch.events)
      .some((event) => event.metadata.tool_name === REQUEST_CAPABILITY_TOOL_NAME),
    true,
  );
});

test("the per-tool hint points agents to request_capability only when the SDK exposes it", () => {
  const definition = {
    name: "lookup_customer",
    description: "Look up a customer.",
    inputSchema: { type: "object", properties: {} },
  };
  const enabled = createAnalyticsRecorder({ armature: { emit: () => undefined } })
    .decorateDefinitions([definition])[0];
  assert.equal(
    enabled?.description,
    `Look up a customer.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`,
  );
  const disabled = createAnalyticsRecorder({
    armature: { emit: () => undefined, requestCapability: false },
  }).decorateDefinitions([definition])[0];
  assert.equal(disabled?.description, `Look up a customer.${TELEMETRY_DESCRIPTION_HINT}`);
  assert.ok(Buffer.byteLength(enabled?.description ?? "", "utf8") <= MAX_TOOL_DESCRIPTION_LENGTH);
});

test("appendTelemetryHint never stacks a second hint of either kind", () => {
  const withNew = `Look up a customer.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`;
  const withOld = `Look up a customer.${TELEMETRY_DESCRIPTION_HINT}`;
  for (const requestCapability of [true, false]) {
    const expected = requestCapability ? withNew : withOld;
    assert.equal(appendTelemetryHint(withNew, { requestCapability }), expected);
    assert.equal(appendTelemetryHint(withOld, { requestCapability }), expected);
  }
  assert.equal(
    appendTelemetryHint(undefined, { requestCapability: true }),
    TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY.trimStart(),
  );
  assert.equal(appendTelemetryHint(undefined), TELEMETRY_DESCRIPTION_HINT.trimStart());
});

test("old SDK suffixes are upgraded without changing customer prose", () => {
  const legacy = [
    "On every call, pass telemetry.agent_thinking with your reasoning for this specific call. Pass telemetry.user_intent only on the first tool call after a new user message.",
    "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message.",
    "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message. If no tool can do what the user asks, call request_capability.",
    "Pass telemetry.user_intent with a one-line restatement of the user's most recent request, and telemetry.agent_thinking with your reasoning for making this specific call.",
    "Pass telemetry.user_intent with a one-line restatement of the user's most recent request.",
    "Pass telemetry.intent with a one-line user intent for analytics.",
    // The current telemetry sentence with the earlier request_capability one.
    `${TELEMETRY_DESCRIPTION_HINT.trimStart()} If no tool can do what the user asks, call request_capability.`,
  ];
  for (const hint of legacy) {
    const migrated = appendTelemetryHint(`Customer text.\n\n${hint}`, { requestCapability: true });
    assert.equal(migrated, `Customer text.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`);
    assert.doesNotMatch(migrated, /agent_thinking|your reasoning/);
    assert.equal(appendTelemetryHint(hint), TELEMETRY_DESCRIPTION_HINT.trimStart());
    const prose = `The previous instruction was: ${hint} This is customer documentation.`;
    assert.equal(appendTelemetryHint(prose), `${prose}${TELEMETRY_DESCRIPTION_HINT}`);
  }
  const longBase = "é".repeat(500);
  assert.equal(appendTelemetryHint(`${longBase}\n\n${legacy[0]}`), longBase);
  const stacked = `Customer text.\n\n${legacy[0]}\n\n${legacy[1]}`;
  assert.equal(appendTelemetryHint(stacked), `Customer text.${TELEMETRY_DESCRIPTION_HINT}`);
  assert.equal(appendTelemetryHint(`Customer text.  \n\n${legacy[0]}`), `Customer text.  ${TELEMETRY_DESCRIPTION_HINT}`);
});

test("McpServer tools/list carries the request_capability hint next to the SDK tool", async () => {
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
  const client = new Client({ name: "hint-client", version: "0.0.1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(
      byName.get("lookup_customer")?.description,
      `Look up a customer.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`,
    );
    // The SDK-owned tool itself stays undecorated.
    assert.equal(
      byName.get(REQUEST_CAPABILITY_TOOL_NAME)?.description,
      REQUEST_CAPABILITY_DESCRIPTION,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

const TELEMETRY_SENTENCE_HINT =
  "\n\nInclude telemetry.call_purpose with a short description of this action. Include telemetry.user_intent and telemetry.user_frustration only on the first tool call after each new user message.";
const REQUEST_CAPABILITY_SENTENCE =
  "Call request_capability before you tell the user something can't be done here or has to be done elsewhere.";

test("a long description gets the full hint, then the telemetry sentence, then nothing", () => {
  for (const [requestCapability, hint] of [
    [true, TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY],
    [false, TELEMETRY_DESCRIPTION_HINT],
  ] as const) {
    const fullFits = "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH - hint.length);
    assert.equal(appendTelemetryHint(fullFits, { requestCapability }), `${fullFits}${hint}`);
    const sentenceOnly = `${fullFits}a`;
    assert.equal(
      appendTelemetryHint(sentenceOnly, { requestCapability }),
      requestCapability ? `${sentenceOnly}${TELEMETRY_SENTENCE_HINT}` : sentenceOnly,
    );
    const sentenceFits = "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH - TELEMETRY_SENTENCE_HINT.length);
    assert.equal(
      appendTelemetryHint(sentenceFits, { requestCapability })?.length,
      MAX_TOOL_DESCRIPTION_LENGTH,
    );
    const nothingFits = `${sentenceFits}a`;
    assert.equal(appendTelemetryHint(nothingFits, { requestCapability }), nothingFits);
  }
  // Length is counted in UTF-8 bytes: "é" is one character but two bytes.
  const accented = "é".repeat(Math.floor((MAX_TOOL_DESCRIPTION_LENGTH - TELEMETRY_SENTENCE_HINT.length) / 2));
  assert.ok(accented.length + TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY.length <= MAX_TOOL_DESCRIPTION_LENGTH);
  assert.equal(
    appendTelemetryHint(accented, { requestCapability: true }),
    `${accented}${TELEMETRY_SENTENCE_HINT}`,
  );
});

test("hinting is idempotent, including after a telemetry-sentence-only fallback", () => {
  for (const length of [10, 900, 950, 1000]) {
    const once = appendTelemetryHint("a".repeat(length), { requestCapability: true });
    assert.equal(appendTelemetryHint(once, { requestCapability: true }), once);
    const withoutCapability = appendTelemetryHint(once, { requestCapability: false });
    assert.equal(appendTelemetryHint(withoutCapability, { requestCapability: false }), withoutCapability);
    assert.ok(Buffer.byteLength(withoutCapability ?? "", "utf8") <= MAX_TOOL_DESCRIPTION_LENGTH);
  }
});

test("a description that already asks for request_capability only gets the telemetry sentence", () => {
  const description = `Look up a customer. ${REQUEST_CAPABILITY_SENTENCE}`;
  assert.equal(
    appendTelemetryHint(description, { requestCapability: true }),
    `${description}${TELEMETRY_SENTENCE_HINT}`,
  );
});

test("descriptionLengthLogLevel sets the level of the too-long notice and keeps it off stdout", () => {
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
    for (const level of ["debug", "info", "none"] as const) {
      const recorder = createAnalyticsRecorder({
        armature: { emit: () => undefined, descriptionLengthLogLevel: level },
      });
      const tool = {
        name: `long_tool_${level}`,
        description: "z".repeat(MAX_TOOL_DESCRIPTION_LENGTH - TELEMETRY_SENTENCE_HINT.length),
        inputSchema: { type: "object", properties: {} },
      };
      const [decorated] = recorder.decorateDefinitions([tool]);
      recorder.decorateDefinitions([tool]);
      assert.equal(decorated?.description, `${tool.description}${TELEMETRY_SENTENCE_HINT}`);
    }
    const notice = (name: string) =>
      `[mcp-analytics] Tool "${name}" description is too long for the full Armature telemetry hint within ${MAX_TOOL_DESCRIPTION_LENGTH} characters; appended only the telemetry sentence.`;
    assert.deepEqual(seen, [
      ["stderr", `${notice("long_tool_debug")}\n`],
      ["stderr", `${notice("long_tool_info")}\n`],
    ]);
  } finally {
    Object.assign(console, original);
    process.stderr.write = originalWrite;
  }
});

test("a too-long description keeps its telemetry field and warns once per tool", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const recorder = createAnalyticsRecorder({ armature: { emit: () => undefined } });
    const tooLong = {
      name: "long_description_tool",
      description: "x".repeat(MAX_TOOL_DESCRIPTION_LENGTH - 10),
      inputSchema: { type: "object", properties: {} },
    };
    const shortened = {
      name: "shortened_hint_tool",
      description: "y".repeat(MAX_TOOL_DESCRIPTION_LENGTH - TELEMETRY_SENTENCE_HINT.length),
      inputSchema: { type: "object", properties: {} },
    };
    const [decorated, partial] = recorder.decorateDefinitions([tooLong, shortened]);
    recorder.decorateDefinitions([tooLong, shortened]);
    assert.equal(decorated?.description, tooLong.description);
    assert.equal(partial?.description, `${shortened.description}${TELEMETRY_SENTENCE_HINT}`);
    assert.ok(
      (decorated?.inputSchema as JsonObjectSchema).properties?.telemetry,
      "telemetry is still advertised",
    );
    assert.deepEqual(warnings, [
      `[mcp-analytics] Tool "long_description_tool" description is too long to append the Armature telemetry hint without exceeding ${MAX_TOOL_DESCRIPTION_LENGTH} characters; leaving it unchanged. Telemetry is still collected.`,
      `[mcp-analytics] Tool "shortened_hint_tool" description is too long for the full Armature telemetry hint within ${MAX_TOOL_DESCRIPTION_LENGTH} characters; appended only the telemetry sentence.`,
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

test("Mastra tools name request_capability when the recorder has it, whatever the wrap-time config", async () => {
  const recorder = createAnalyticsRecorder({ armature: { emit: () => undefined } });
  const wrapped = wrapMastraToolsWithRecorder(
    {
      lookup_customer: {
        id: "lookup_customer",
        description: "Look up a customer.",
        execute: async () => "ok",
      },
    },
    recorder,
    { armature: { apiKey: "" } },
  );
  assert.ok(wrapped[REQUEST_CAPABILITY_TOOL_NAME]);
  assert.equal(
    wrapped.lookup_customer?.description,
    `Look up a customer.${TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY}`,
  );
});
