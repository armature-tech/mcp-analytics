import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { z } from "zod";
import { createMcpHandler } from "mcp-handler";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { withMcpAnalytics } from "../src/server.js";
import { withMcpHandlerAnalytics } from "../src/mcp-handler.js";
import type { AnalyticsIngestBatch, McpAnalyticsConfig } from "../src/types.js";

// Compatibility of the v1 instrumentation with Vercel's `mcp-handler` (1.1.0,
// exact devDep; peer-pins @modelcontextprotocol/sdk@1.26.0 exactly).
//
// mcp-handler hands the initialize callback a REAL official-SDK `McpServer`,
// so the package root's `withMcpAnalytics` prototype patch covers its tool
// calls transitively — PROVIDED both packages resolve the same SDK build.
// The SDK ships distinct ESM and CJS builds (two different `McpServer`
// classes, asserted below); resolution is per-format, so a pure-ESM host
// (this test: our ESM sources + mcp-handler's dist/index.mjs) and a pure-CJS
// host each converge on one build. Only a host that mixes formats (e.g. CJS
// app code requiring this package while a bundler gives mcp-handler the ESM
// build) would split the prototypes and lose coverage — documented in the
// README's mcp-handler section.
//
// Session/client identity through mcp-handler's transport, verified against
// node_modules/mcp-handler/dist/index.js: the streamable-HTTP leg constructs
// `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator })` with
// `sessionIdGenerator` typed `undefined` (stateless only), and creates a
// fresh `McpServer` per POST. Consequences asserted below: no `Mcp-Session-Id`
// is ever minted, tool calls record with a null session hint and an unknown
// client. `withMcpHandlerAnalytics` (src/mcp-handler.ts) repairs both via the
// v1 stateless pattern: initialize-body sniffing + an identity-bearing
// session id attached to the initialize response.

const SEED = "11111111-2222-4333-8444-555555555555";

// mcp-handler starts a module-level stale-server sweep
// (`setInterval(..., 30_000)`, dist/index.js) on first handler creation and
// never clears or unrefs it, which would keep this test-file child process
// alive forever and hang the whole suite. Auto-unref intervals created in this
// process; node:test runs each file in its own child, so nothing leaks out.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = realSetInterval(...args);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return timer;
}) as typeof setInterval;

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    events: () => batches.flatMap((b) => b.events),
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

const testConfig = (
  emit: (batch: AnalyticsIngestBatch) => void,
): McpAnalyticsConfig => ({
  armature: {
    delivery: "await",
    actorId: "mcp-handler-test-actor",
    emit,
  },
});

// A handler with the documented integration shape: the initialize callback
// runs PER REQUEST, and the registrations inside the withMcpAnalytics factory
// are intercepted by the McpServer prototype patch.
const buildHandler = (config: McpAnalyticsConfig, onArgs?: (args: unknown) => void) =>
  createMcpHandler(
    (server) => {
      withMcpAnalytics(config, () => {
        server.registerTool(
          "echo",
          {
            description: "Echo a message",
            // Same cast the suite's other registerTool tests use: the SDK's
            // zod-compat generics blow TS's instantiation depth on zod 3 shapes.
            inputSchema: { msg: z.string() } as unknown as ZodRawShapeCompat,
          },
          async (args: unknown) => {
            const { msg } = args as { msg: string };
            onArgs?.({ msg });
            return { content: [{ type: "text" as const, text: `echo:${msg}` }] };
          },
        );
        return server;
      });
    },
    {},
    { basePath: "" },
  );

const post = (
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

const initializeBody = (id = 0) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: { sampling: {} },
    clientInfo: { name: "compat-client", version: "2.0.0" },
  },
});

const toolCallBody = (msg: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "echo", arguments: { msg } },
});

// mcp-handler answers with an SSE stream (`event: message\ndata: {...}`).
const readSseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  assert.ok(dataLine, `expected an SSE data line, got: ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice("data: ".length));
};

test("mcp-handler dual-build reality: the SDK ships two McpServer classes; same-format hosts dedupe to one", () => {
  const require2 = createRequire(import.meta.url);
  const cjs = require2("@modelcontextprotocol/sdk/server/mcp.js") as {
    McpServer: unknown;
  };
  // Two distinct classes exist — the prototype patch can only ever cover the
  // build THIS package loaded. Coverage of mcp-handler holds because a
  // same-format host resolves both packages to the same build (proven by the
  // event flow in the next test); a mixed-format host would split them.
  assert.notEqual(cjs.McpServer, McpServer);
});

test("mcp-handler without the shim: prototype patch reaches the per-request server, but session and client identity are lost", async () => {
  const { events, emit } = collectBatches();
  const config = testConfig(emit);
  let received: unknown;
  const handler = buildHandler(config, (args) => {
    received = args;
  });

  const initResponse = await post(handler, initializeBody());
  assert.equal(initResponse.status, 200);
  assert.equal(
    initResponse.headers.get("mcp-session-id"),
    null,
    "stateless transport: sessionIdGenerator is typed undefined, no id is ever minted",
  );
  const initPayload = (await readSseJson(initResponse)) as {
    result?: { serverInfo?: { name?: string } };
  };
  assert.ok(initPayload.result?.serverInfo?.name);

  const callResponse = await post(handler, toolCallBody("plain"));
  assert.equal(callResponse.status, 200);
  const callPayload = (await readSseJson(callResponse)) as {
    result?: { content?: { text?: string }[] };
    error?: unknown;
  };
  assert.equal(callPayload.error, undefined);
  assert.equal(callPayload.result?.content?.[0]?.text, "echo:plain");
  assert.deepEqual(received, { msg: "plain" });

  // The patch reached mcp-handler's McpServer: the call was recorded.
  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.ok(toolCall, "prototype patch must cover mcp-handler transitively");
  assert.equal(toolCall?.ok, true);
  assert.equal(toolCall?.metadata.tool_name, "echo");
  // ...but with nothing to key a session on: HTTP headers exist (so the stdio
  // fallback correctly stays out), no Mcp-Session-Id was ever issued, and the
  // initialize carrying clientInfo landed on a throwaway per-request server.
  assert.equal(toolCall?.session_id_hint, null);
  assert.equal(
    events().filter((e) => e.kind === "session_init").length,
    0,
    "no session key, no session_init",
  );
});

test("withMcpHandlerAnalytics mints the identity-bearing session id at initialize and records a full session_init", async () => {
  const { events, emit } = collectBatches();
  const config = testConfig(emit);
  const handler = withMcpHandlerAnalytics(buildHandler(config), config);

  const initResponse = await post(handler, initializeBody(), {
    "x-armature-session-seed": SEED,
  });
  assert.equal(initResponse.status, 200);
  const minted = initResponse.headers.get("mcp-session-id");
  assert.equal(
    minted,
    `mcp_compat-client_v_2.0.0_${SEED}`,
    "identity-bearing id honoring X-Armature-Session-Seed",
  );
  // The response body is passed through intact (stream re-wrapped only).
  const initPayload = (await readSseJson(initResponse)) as {
    result?: { protocolVersion?: string };
  };
  assert.equal(initPayload.result?.protocolVersion, "2025-03-26");

  const init = events().find((e) => e.kind === "session_init");
  assert.ok(init, "session_init is recorded at initialize");
  assert.equal(init?.session_id_hint, minted);
  assert.equal(init?.metadata.client_name, "compat-client");
  assert.equal(init?.metadata.client_version, "2.0.0");
  assert.equal(init?.metadata.protocol_version, "2025-03-26");
  assert.deepEqual(init?.metadata.capabilities, { sampling: {} });
});

test("withMcpHandlerAnalytics end-to-end: echoed session id attributes tool calls and recovers the client; session_init event ids converge", async () => {
  const { events, emit } = collectBatches();
  const config = testConfig(emit);
  const handler = withMcpHandlerAnalytics(buildHandler(config), config);

  const initResponse = await post(handler, initializeBody(), {
    "x-armature-session-seed": SEED,
  });
  const minted = initResponse.headers.get("mcp-session-id");
  assert.ok(minted);
  await initResponse.text();

  // A conforming client echoes the server-issued id on every later request.
  const callResponse = await post(handler, toolCallBody("attributed"), {
    "mcp-session-id": minted,
  });
  assert.equal(callResponse.status, 200);
  assert.equal(
    callResponse.headers.get("mcp-session-id"),
    minted,
    "the shim keeps echoing the id so the client keeps carrying it",
  );
  const callPayload = (await readSseJson(callResponse)) as {
    result?: { content?: { text?: string }[] };
  };
  assert.equal(callPayload.result?.content?.[0]?.text, "echo:attributed");

  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.session_id_hint, minted, "echoed header keys the session");

  // The per-request recorder inside the initialize callback re-emits its own
  // session_init on first sight of the session (fresh in-memory dedupe per
  // request) — with the SAME content-addressed event_id as the shim's, so
  // ingest collapses them. The re-emit also proves parseStatelessSessionClientInfo
  // recovered the client from the id alone, cold.
  const inits = events().filter((e) => e.kind === "session_init");
  assert.equal(inits.length, 2, "shim init + per-request re-emit");
  assert.equal(new Set(inits.map((e) => e.event_id)).size, 1, "same event_id, ingest dedupes");
  const reEmit = inits[1];
  assert.equal(reEmit?.metadata.client_name, "compat-client");
  assert.equal(reEmit?.metadata.client_version, "2.0.0");
});

test("withMcpHandlerAnalytics: a client that does not echo the id still gets served; hint stays null (documented limit)", async () => {
  const { events, emit } = collectBatches();
  const config = testConfig(emit);
  const handler = withMcpHandlerAnalytics(buildHandler(config), config);

  const callResponse = await post(handler, toolCallBody("bare"));
  assert.equal(callResponse.status, 200);
  const callPayload = (await readSseJson(callResponse)) as {
    result?: { content?: { text?: string }[] };
  };
  assert.equal(callPayload.result?.content?.[0]?.text, "echo:bare");
  const toolCall = events().find((e) => e.kind === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall?.session_id_hint, null);

  // Non-POST traffic passes through untouched.
  const getResponse = await handler(new Request("http://localhost/mcp", { method: "GET" }));
  assert.equal(getResponse.status, 405);
});
