import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createAnalyticsRecorder,
  instrumentMcpServerTools,
  withMcpAnalytics,
} from "@armature-tech/mcp-analytics";
import { createMastraAnalytics } from "@armature-tech/mcp-analytics/mastra";

const live = Boolean(process.env.SDK_CANARY_READ_API_KEY);
const packageName = "typescript";
const candidate = process.env.npm_package_version || "candidate";
const runId = `${process.env.GITHUB_RUN_ID || "local"}-${process.env.GITHUB_RUN_ATTEMPT || "1"}-${randomUUID()}`;
const apiKey = process.env.SDK_CANARY_INGEST_KEY || "ami_canary_local_not-a-secret";

const sinkRequests = [];
const expectedSessionsByIntent = new Map();
let sink;
let endpointUrl = `${process.env.SDK_CANARY_PLATFORM_URL || "https://app.armature.tech"}/api/mcp-analytics/ingest`;
if (!live) {
  sink = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const batch = JSON.parse(raw);
      sinkRequests.push({ authorization: req.headers.authorization, batch });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: batch.events.length, rejected: [], schema_version: 1 }));
    });
  });
  sink.listen(0, "127.0.0.1");
  await once(sink, "listening");
  endpointUrl = `http://127.0.0.1:${sink.address().port}/api/mcp-analytics/ingest`;
}

const config = () => ({
  armature: {
    apiKey,
    endpointUrl,
    delivery: "await",
    timeoutMs: 10_000,
    actorId: "sdk-canary-shared-actor",
  },
});
const ok = value => ({ content: [{ type: "text", text: value }] });
const failed = value => ({ isError: true, content: [{ type: "text", text: value }] });

const factories = {
  "drop-in": () => {
    let received;
    const wrapped = withMcpAnalytics(config(), () => {
      const server = new McpServer({ name: "ts-canary", version: "1" });
      server.registerTool("canary_echo", { inputSchema: { marker: z.string() } }, async args => { received = args; return ok(args.marker); });
      server.registerTool("canary_expected_error", { inputSchema: { marker: z.string() } }, async args => { received = args; return failed(args.marker); });
      return server;
    });
    return { server: wrapped.result, flush: wrapped.recorder.flush, received: () => received };
  },
  "existing-server": () => {
    let received;
    const server = new McpServer({ name: "ts-canary", version: "1" });
    const result = instrumentMcpServerTools({ server, config: config(), tools: [
      { name: "canary_echo", inputSchema: { marker: z.string() }, handler: async args => { received = args; return ok(args.marker); } },
      { name: "canary_expected_error", inputSchema: { marker: z.string() }, handler: async args => { received = args; return failed(args.marker); } },
    ] });
    return { server, flush: result.recorder.flush, received: () => received };
  },
  registry: () => {
    let received;
    const recorder = createAnalyticsRecorder(config());
    recorder.tool({ name: "canary_echo", inputSchema: { marker: z.string() } }, async args => { received = args; return ok(args.marker); });
    recorder.tool({ name: "canary_expected_error", inputSchema: { marker: z.string() } }, async args => { received = args; return failed(args.marker); });
    return { server: recorder.createMcpServer({ name: "ts-canary", version: "1" }), flush: recorder.flush, received: () => received };
  },
  dispatcher: () => {
    let received;
    const recorder = createAnalyticsRecorder(config());
    const inputSchema = { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] };
    recorder.tool({ name: "canary_echo", inputSchema }, async args => { received = args; return ok(args.marker); });
    recorder.tool({ name: "canary_expected_error", inputSchema }, async args => { received = args; return failed(args.marker); });
    const server = new Server({ name: "ts-canary", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: recorder.toolDefinitions() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => recorder.dispatch(request.params.name, request.params.arguments, { extra }));
    return { server, flush: recorder.flush, received: () => received };
  },
  mastra: () => {
    let received;
    const analytics = createMastraAnalytics(config());
    const tools = analytics.wrapTools({
      canary_echo: { id: "canary_echo", inputSchema: z.object({ marker: z.string() }), execute: async args => { received = args; return ok(args.marker); } },
      canary_expected_error: { id: "canary_expected_error", inputSchema: z.object({ marker: z.string() }), execute: async args => { received = args; return failed(args.marker); } },
    });
    const server = new McpServer({ name: "ts-canary", version: "1" });
    for (const [name, tool] of Object.entries(tools)) {
      server.registerTool(name, { inputSchema: tool.inputSchema.shape }, (args, extra) => tool.execute(args, { mcp: { extra } }));
    }
    return { server, flush: analytics.flush, received: () => received };
  },
};

async function conversation(shape, label, intent) {
  const fixture = factories[shape]();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const sessionId = `${shape}-${label}-${randomUUID()}`;
  serverTransport.sessionId = sessionId;
  const expected = expectedSessionsByIntent.get(intent) || new Set();
  expected.add(sessionId);
  expectedSessionsByIntent.set(intent, expected);
  const client = new Client({ name: "sdk-publish-canary", version: "1" });
  await Promise.all([fixture.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(new Set(listed.tools.map(tool => tool.name)), new Set(["canary_echo", "canary_expected_error"]));
    for (const tool of listed.tools) assert.ok(tool.inputSchema.properties?.telemetry, `${shape}/${tool.name} lacks telemetry schema`);
    await client.callTool({ name: "canary_echo", arguments: { marker: `${label}/call-1`, telemetry: { user_intent: intent, agent_thinking: "exercise the successful path" } } });
    const error = await client.callTool({ name: "canary_expected_error", arguments: { marker: `${label}/call-2`, telemetry: { agent_thinking: "exercise the expected failure path" } } });
    assert.equal(error.isError, true);
    assert.equal("telemetry" in fixture.received(), false, `${shape} leaked telemetry into handler`);
  } finally {
    await client.close();
    await fixture.server.close();
    await fixture.flush();
  }
}

async function readback(shape, intent) {
  const base = process.env.SDK_CANARY_PLATFORM_URL || "https://app.armature.tech";
  const headers = { authorization: `Bearer ${process.env.SDK_CANARY_READ_API_KEY}` };
  const deadline = Date.now() + 90_000;
  let matches = [];
  while (Date.now() < deadline) {
    const url = new URL("/api/armature/v1/insights/sessions", base);
    url.searchParams.set("range", "24h"); url.searchParams.set("intent", intent); url.searchParams.set("limit", "100");
    const response = await fetch(url, { headers });
    assert.equal(response.ok, true, `session readback failed: ${response.status}`);
    const body = await response.json();
    matches = body.sessions.filter(session => session.raw_intent === intent && session.mcp_server_id === process.env.SDK_CANARY_MCP_SERVER_ID);
    if (matches.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const cappedHint = matches.length === 0
    ? " (ingest succeeded, so zero visible sessions usually means the canary organization is subject to a free-tier session-visibility cap; keep the canary org on a non-free plan)"
    : "";
  assert.equal(matches.length, 2, `${shape}: expected two platform sessions, got ${matches.length}${cappedHint}`);
  assert.equal(new Set(matches.map(session => session.session_key)).size, 2);
  assert.equal(new Set(matches.map(session => session.actor_id)).size, 1);
  for (const session of matches) {
    assert.equal(session.event_count, 2); assert.equal(session.ok_count, 1); assert.equal(session.error_count, 1);
    const traceResponse = await fetch(new URL(`/api/armature/v1/insights/sessions/${session.id}/trace`, base), { headers });
    assert.equal(traceResponse.ok, true);
    const trace = JSON.stringify(await traceResponse.json());
    const label = trace.includes("session-a") ? "session-a" : "session-b";
    const other = label === "session-a" ? "session-b" : "session-a";
    assert.ok(trace.includes(`${label}/call-1`) && trace.includes(`${label}/call-2`));
    assert.equal(trace.includes(other), false);
    if (process.env.GITHUB_STEP_SUMMARY) console.log(`platform session ${shape}/${label}: ${base}/mcp-analytics/sessions/${session.id}`);
  }
}

try {
  for (const shape of Object.keys(factories)) {
    const intent = `sdk-canary/${packageName}/${candidate}/${shape}/${runId}`;
    await Promise.all([conversation(shape, "session-a", intent), conversation(shape, "session-b", intent)]);
    if (live) await readback(shape, intent);
    console.log(`ok ${shape}`);
  }
  if (!live) {
    const events = sinkRequests.flatMap(request => request.batch.events);
    assert.ok(events.length >= Object.keys(factories).length * 4);
    for (const request of sinkRequests) assert.equal(request.authorization, `Bearer ${apiKey}`);
    for (const event of events.filter(event => event.kind === "tool_call")) {
      assert.ok(event.session_id_hint); assert.ok(event.metadata.context);
    }
    for (const [intent, expectedSessions] of expectedSessionsByIntent) {
      assert.equal(expectedSessions.size, 2, `${intent}: fixture did not create two sessions`);
      const intentCalls = events.filter(event => event.kind === "tool_call" && event.metadata.intent === intent);
      assert.equal(intentCalls.length, 2, `${intent}: expected one declared intent per session`);
      const toolCalls = events.filter(event => event.kind === "tool_call" && expectedSessions.has(event.session_id_hint));
      assert.equal(toolCalls.length, 4, `${intent}: expected two calls in each of two sessions`);
      const actualSessions = new Set(toolCalls.map(event => event.session_id_hint));
      assert.deepEqual(
        [...actualSessions].sort(),
        [...expectedSessions].sort(),
        `${intent}: recorder did not preserve the transport session IDs`,
      );
      for (const sessionId of expectedSessions) {
        assert.equal(
          toolCalls.filter(event => event.session_id_hint === sessionId).length,
          2,
          `${intent}: calls from one MCP session were merged or split`,
        );
      }
    }
  }
} finally {
  if (sink) await new Promise(resolve => sink.close(resolve));
}
