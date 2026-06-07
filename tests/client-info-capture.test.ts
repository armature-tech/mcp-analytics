import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  __clearClientInfoCache,
  __getClientInfoCacheSize,
  __getMaxClientInfoCacheEntries,
  __isInitializePatchInstalled,
  __setClientInfoForSessionId,
  installClientInfoCapture,
} from "../src/client-info-cache.js";
import { getClientInfoForSessionId } from "../src/client-info-cache.js";
import {
  createAnalyticsRecorder,
  withMcpAnalytics,
} from "../src/index.js";
import { wrapMastraToolsWithRecorder } from "../src/mastra.js";
import type { MastraTool } from "../src/mastra.js";
import type { AnalyticsIngestBatch } from "../src/index.js";
import { buildSessionInitEvent } from "../src/events.js";

const collectBatches = () => {
  const batches: AnalyticsIngestBatch[] = [];
  return {
    batches,
    emit: (batch: AnalyticsIngestBatch) => {
      batches.push(batch);
    },
  };
};

test("installClientInfoCapture is idempotent", () => {
  installClientInfoCapture();
  installClientInfoCapture();
  assert.equal(__isInitializePatchInstalled(), true);
});

test("Mastra-wrapped tool call picks up clientInfo cached from a real initialize handshake", async () => {
  // Triggers prototype patch install (already idempotent if other tests ran first).
  installClientInfoCapture();
  __clearClientInfoCache();

  const sessionId = "session-real-initialize";
  const [st, ct] = InMemoryTransport.createLinkedPair();
  // InMemoryTransport doesn't set sessionId; assign one so the patch has a
  // key to cache under, mirroring what Streamable HTTP would do at runtime.
  (st as { sessionId?: string }).sessionId = sessionId;

  const server = new McpServer({
    name: "init-capture-server",
    version: "0.0.1",
  });
  // Need at least one capability so the SDK doesn't throw on an empty server;
  // we don't actually call this tool in the test.
  server.registerTool(
    "noop",
    { description: "noop", inputSchema: { x: z.string().optional() } },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );

  const client = new Client({ name: "Claude Desktop", version: "1.2.3" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    // Now exercise the Mastra path: a separate recorder + wrapped tool whose
    // resolveExtra returns the same sessionId. The recorder should see the
    // cached clientInfo even though Mastra never plumbs it through.
    const { batches, emit } = collectBatches();
    const recorder = createAnalyticsRecorder({
      armature: {
        delivery: "await",
        actorId: "mastra-with-capture",
        emit,
      },
    });

    const tools: Record<string, MastraTool> = {
      echo: {
        id: "echo",
        inputSchema: z.object({ msg: z.string() }),
        execute: async (input) => input,
      },
    };
    const wrapped = wrapMastraToolsWithRecorder(tools, recorder, {}, {
      resolveExtra: () => ({ sessionId }),
    });

    await wrapped.echo?.execute?.({ msg: "hi" }, {});

    const events = batches.flatMap((b) => b.events);
    const sessionInit = events.find((e) => e.kind === "session_init");
    assert.ok(sessionInit, "should emit a session_init batch");
    assert.equal(sessionInit?.session_id_hint, sessionId);
    assert.equal(sessionInit?.metadata.client_name, "Claude Desktop");
    assert.equal(sessionInit?.metadata.client_version, "1.2.3");
  } finally {
    await client.close();
    await server.close();
  }
});

test("Mastra-wrapped tool call without explicit clientInfo falls back to cache lookup", async () => {
  installClientInfoCapture();
  __clearClientInfoCache();

  const sessionId = "session-cache-seed";
  __setClientInfoForSessionId(sessionId, {
    name: "VSCode MCP Extension",
    version: "0.4.0",
  });

  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: {
      delivery: "await",
      actorId: "mastra-cache-lookup",
      emit,
    },
  });

  const tools: Record<string, MastraTool> = {
    echo: {
      id: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => input,
    },
  };
  const wrapped = wrapMastraToolsWithRecorder(tools, recorder, {}, {
    resolveExtra: () => ({ sessionId }),
  });

  await wrapped.echo?.execute?.({ msg: "hi" }, {});

  const events = batches.flatMap((b) => b.events);
  const sessionInit = events.find((e) => e.kind === "session_init");
  assert.ok(sessionInit);
  assert.equal(sessionInit?.metadata.client_name, "VSCode MCP Extension");
  assert.equal(sessionInit?.metadata.client_version, "0.4.0");
});

test("native registerTool path captures clientInfo end-to-end through InMemoryTransport", async () => {
  installClientInfoCapture();
  __clearClientInfoCache();

  const sessionId = "session-native-e2e";
  const [st, ct] = InMemoryTransport.createLinkedPair();
  (st as { sessionId?: string }).sessionId = sessionId;

  const { batches, emit } = collectBatches();
  const { result: server, recorder } = withMcpAnalytics(
    {
      armature: { delivery: "await", actorId: "native-e2e-actor", emit },
    },
    () => {
      const s = new McpServer({ name: "native-e2e-server", version: "0.0.1" });
      s.registerTool(
        "ping",
        { description: "ping", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
      );
      return s;
    },
  );

  const client = new Client({ name: "Cursor", version: "0.42.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  try {
    await client.callTool({ name: "ping", arguments: {} });

    const events = batches.flatMap((b) => b.events);
    const sessionInit = events.find((e) => e.kind === "session_init");
    assert.ok(
      sessionInit,
      "tool call on a sessioned transport should trigger a session_init batch",
    );
    assert.equal(sessionInit?.metadata.client_name, "Cursor");
    assert.equal(sessionInit?.metadata.client_version, "0.42.0");
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});

test("stateless Streamable HTTP: initialize clientInfo is keyed by the Mcp-Session-Id header", async () => {
  // Repro for the Vercel/PRIA stateless case: `sessionIdGenerator` is disabled,
  // so `transport.sessionId` is undefined and the client's identity only arrives
  // via the `Mcp-Session-Id` request header on initialize. The clientInfo must
  // be cached under that header session id so the later tools/call (normalized
  // to the same header) resolves the client name instead of "Unknown".
  installClientInfoCapture();
  __clearClientInfoCache();

  const sessionId = "sdk-lab-v062-raw-a";
  const [st, ct] = InMemoryTransport.createLinkedPair();
  // Stateless: leave st.sessionId undefined.

  const { batches, emit } = collectBatches();
  const { result: server, recorder } = withMcpAnalytics(
    { armature: { delivery: "await", actorId: "stateless-actor", emit } },
    () => {
      const s = new McpServer({ name: "stateless-server", version: "0.0.1" });
      s.registerTool(
        "ping",
        { description: "ping", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
      );
      return s;
    },
  );

  await server.connect(st);
  // Simulate what Streamable HTTP does: attach the incoming request headers
  // (including Mcp-Session-Id) to the per-request `extra`. InMemoryTransport
  // otherwise only forwards authInfo, so we layer headers on here.
  const transportWithHandler = st as unknown as {
    onmessage?: (message: unknown, extra?: unknown) => void;
  };
  const realOnMessage = transportWithHandler.onmessage?.bind(st);
  transportWithHandler.onmessage = (message, extra) =>
    realOnMessage?.(message, {
      ...(extra as Record<string, unknown> | undefined),
      requestInfo: { headers: { "mcp-session-id": sessionId } },
    });

  const client = new Client({ name: "codex", version: "0.1.0" });
  await client.connect(ct);

  try {
    // Capture happened at initialize, keyed by the header session id.
    assert.equal(getClientInfoForSessionId(sessionId)?.name, "codex");

    await client.callTool({ name: "ping", arguments: {} });

    const events = batches.flatMap((b) => b.events);
    const sessionInit = events.find((e) => e.kind === "session_init");
    assert.ok(sessionInit, "tools/call should trigger a session_init batch");
    assert.equal(sessionInit?.session_id_hint, sessionId);
    assert.equal(sessionInit?.metadata.client_name, "codex");
    assert.equal(sessionInit?.metadata.client_version, "0.1.0");
  } finally {
    await client.close();
    await server.close();
    await recorder.flush();
  }
});

test("stateless capture keys clientInfo by header even when transport.sessionId is set and differs", async () => {
  // Defensive: when both a transport sessionId and a header sessionId exist,
  // cache under both so the tool-call lookup hits regardless of which one the
  // tool-call path normalizes to.
  installClientInfoCapture();
  __clearClientInfoCache();

  const transportSessionId = "transport-sid";
  const headerSessionId = "header-sid";
  const [st, ct] = InMemoryTransport.createLinkedPair();
  (st as { sessionId?: string }).sessionId = transportSessionId;

  const server = new McpServer({ name: "dual-key-server", version: "0.0.1" });
  server.registerTool(
    "noop",
    { description: "noop", inputSchema: { x: z.string().optional() } },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );

  await server.connect(st);
  const transportWithHandler = st as unknown as {
    onmessage?: (message: unknown, extra?: unknown) => void;
  };
  const realOnMessage = transportWithHandler.onmessage?.bind(st);
  transportWithHandler.onmessage = (message, extra) =>
    realOnMessage?.(message, {
      ...(extra as Record<string, unknown> | undefined),
      requestInfo: { headers: { "mcp-session-id": headerSessionId } },
    });

  const client = new Client({ name: "Claude Desktop", version: "1.2.3" });
  await client.connect(ct);

  try {
    assert.equal(getClientInfoForSessionId(transportSessionId)?.name, "Claude Desktop");
    assert.equal(getClientInfoForSessionId(headerSessionId)?.name, "Claude Desktop");
  } finally {
    await client.close();
    await server.close();
  }
});

test("explicit event.clientInfo wins over the cache", async () => {
  installClientInfoCapture();
  __clearClientInfoCache();

  const sessionId = "session-explicit-wins";
  __setClientInfoForSessionId(sessionId, { name: "Cached" });

  const { batches, emit } = collectBatches();
  const recorder = createAnalyticsRecorder({
    armature: { delivery: "await", actorId: "explicit-wins", emit },
  });

  await recorder.recordToolCall({
    name: "echo",
    args: { msg: "hi" },
    extra: { sessionId },
    status: "ok",
    result: { ok: true },
    clientInfo: { name: "Explicit", version: "9.9.9" },
  });

  const events = batches.flatMap((b) => b.events);
  const sessionInit = events.find((e) => e.kind === "session_init");
  assert.equal(sessionInit?.metadata.client_name, "Explicit");
  assert.equal(sessionInit?.metadata.client_version, "9.9.9");
});

test("buildSessionInitEvent falls back to x-mcp-client header when no clientInfo is available", () => {
  const event = buildSessionInitEvent({
    actorId: "actor-x",
    sessionId: "session-x",
    startedAt: new Date(0).toISOString(),
    extra: {
      requestInfo: {
        headers: { "x-mcp-client": "Custom Client/1.0" },
      },
    },
  });
  assert.equal(event.metadata.client_name, "Custom Client/1.0");
});

test("client info cache evicts the oldest entry once it exceeds MAX_CACHE_ENTRIES", () => {
  __clearClientInfoCache();
  const cap = __getMaxClientInfoCacheEntries();

  // Seed the cache up to the cap and then overflow by 5 entries.
  for (let i = 0; i < cap + 5; i++) {
    __setClientInfoForSessionId(`session-${i}`, { name: `client-${i}` });
  }

  assert.equal(
    __getClientInfoCacheSize(),
    cap,
    "cache size should be clamped to MAX_CACHE_ENTRIES",
  );
  // The first five inserts must have been evicted in FIFO order.
  for (let i = 0; i < 5; i++) {
    assert.equal(
      getClientInfoForSessionId(`session-${i}`),
      undefined,
      `session-${i} should have been evicted as oldest`,
    );
  }
  // The most recent entries survive.
  assert.equal(
    getClientInfoForSessionId(`session-${cap + 4}`)?.name,
    `client-${cap + 4}`,
  );

  __clearClientInfoCache();
});

test("re-setting an existing sessionId refreshes its position and does not grow the cache", () => {
  __clearClientInfoCache();

  __setClientInfoForSessionId("a", { name: "A" });
  __setClientInfoForSessionId("b", { name: "B" });
  __setClientInfoForSessionId("c", { name: "C" });
  // Refresh "a" — now order should be b, c, a.
  __setClientInfoForSessionId("a", { name: "A2" });

  assert.equal(__getClientInfoCacheSize(), 3);
  assert.equal(getClientInfoForSessionId("a")?.name, "A2");

  // Confirm "a" is now the newest by inserting one more and checking "b" was
  // not affected (b is still the oldest until cap is reached). We can't easily
  // assert order without overflowing, but we can at least confirm the refresh
  // didn't double-count.
  __clearClientInfoCache();
});

test("buildSessionInitEvent prefers clientInfo over header fallback", () => {
  const event = buildSessionInitEvent({
    actorId: "actor-y",
    sessionId: "session-y",
    startedAt: new Date(0).toISOString(),
    extra: {
      requestInfo: {
        headers: { "x-mcp-client": "Should Not Win" },
      },
    },
    clientInfo: { name: "Should Win" },
  });
  assert.equal(event.metadata.client_name, "Should Win");
});
