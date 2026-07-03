import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  resolveStatelessHttpSession,
  withMcpAnalytics,
  type AnalyticsIngestBatch,
} from "../src/index.js";

// Transport-level e2e: the unit suites drive the recorder with hand-built
// `extra` objects and in-memory transports, which is exactly how the
// null-session_id_hint bug shipped — nothing ever exercised what a REAL
// transport hands the SDK. These tests spawn the instrumented server as a
// real child process over stdio (the `claude -p` shape) and talk real
// Streamable HTTP, asserting on the payloads that actually leave the SDK.

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/stdio-instrumented-server.ts", import.meta.url),
);

const INGEST_API_KEY = "e2e-test-ingest-key";

type SinkRequest = { authorization?: string; batch: AnalyticsIngestBatch };

// Minimal in-test stand-in for POST /api/mcp-analytics/ingest. The child
// process can only reach us over HTTP — emit hooks don't cross process
// boundaries — so this is the observation point for everything below.
const startIngestSink = async () => {
  const requests: SinkRequest[] = [];
  const server: HttpServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        authorization: req.headers.authorization,
        batch: JSON.parse(body) as AnalyticsIngestBatch,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: 1, rejected: [] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/ingest`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// One simulated `claude -p` conversation: spawn the instrumented fixture as a
// child process over real stdio, initialize, call one tool, disconnect.
const runCliConversation = async (sinkUrl: string, message: string) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fixturePath],
    cwd: packageRoot,
    env: {
      ...getDefaultEnvironment(),
      ANALYTICS_INGEST_URL: sinkUrl,
      ANALYTICS_INGEST_API_KEY: INGEST_API_KEY,
    },
  });
  const client = new Client({ name: "claude-code", version: "9.9.9" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "echo", arguments: { msg: message } });
    assert.equal((result.content as { text?: string }[])[0]?.text, message);
  } finally {
    await client.close();
  }
};

test("e2e stdio: two CLI conversations from the same user reach ingest as two distinct sessions", async () => {
  const sink = await startIngestSink();
  try {
    await runCliConversation(sink.url, "first run");
    await runCliConversation(sink.url, "second run");

    // The fixture authenticates like a real deployment.
    for (const request of sink.requests) {
      assert.equal(request.authorization, `Bearer ${INGEST_API_KEY}`);
    }

    const events = sink.requests.flatMap((r) => r.batch.events);
    const sessionInits = events.filter((e) => e.kind === "session_init");
    const toolCalls = events.filter((e) => e.kind === "tool_call");
    assert.equal(sessionInits.length, 2, "each stdio conversation emits one session_init");
    assert.equal(toolCalls.length, 2);

    // The regression itself: every event must carry a session id...
    for (const event of events) {
      assert.equal(typeof event.session_id_hint, "string", `${event.kind} shipped a null hint`);
    }
    // ...both conversations came from the same (anonymous) actor, exactly the
    // merge scenario from production...
    assert.equal(new Set(events.map((e) => e.actor_id)).size, 1);
    // ...and yet they are distinguishable: one id per process, two in total.
    const hints = new Set(events.map((e) => e.session_id_hint));
    assert.equal(hints.size, 2, "two CLI processes must yield two session ids");
    assert.equal(sessionInits[0]?.session_id_hint !== sessionInits[1]?.session_id_hint, true);

    // The initialize handshake's clientInfo crossed into telemetry, so the
    // dashboard can attribute CLI sessions.
    for (const init of sessionInits) {
      assert.equal(init.metadata.client_name, "claude-code");
      assert.equal(init.metadata.client_version, "9.9.9");
    }
  } finally {
    await sink.close();
  }
});

// ─── Streamable HTTP (stateful) ────────────────────────────────────────────

// Instrumented McpServer behind a real StreamableHTTPServerTransport on a
// real HTTP listener. In-process emit collection is fine here — the thing
// under test is what the HTTP transport hands the recorder.
const startInstrumentedHttpServer = async (
  emit: (batch: AnalyticsIngestBatch) => void,
) => {
  const sessionId = `http-${randomUUID()}`;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    enableJsonResponse: true,
  });
  const { result: mcp } = withMcpAnalytics(
    { armature: { delivery: "await", emit } },
    () => {
      const s = new McpServer({ name: "e2e-http-fixture", version: "0.0.1" });
      s.registerTool(
        "echo",
        { description: "echo", inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: "text" as const, text: msg }] }),
      );
      return s;
    },
  );
  await mcp.connect(transport);

  const httpServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address() as AddressInfo;
  return {
    sessionId,
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
};

// ─── Streamable HTTP (stateful, multi-session, child process) ──────────────

const httpFixturePath = fileURLToPath(
  new URL("./fixtures/http-instrumented-server.ts", import.meta.url),
);

// Spawn the stateful HTTP fixture as a child process and wait for it to
// announce its port on stdout.
const spawnHttpFixture = async (sinkUrl: string) => {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", httpFixturePath],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        ANALYTICS_INGEST_URL: sinkUrl,
        ANALYTICS_INGEST_API_KEY: INGEST_API_KEY,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const lines = createInterface({ input: child.stdout! });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("HTTP fixture did not announce a port within 15s")),
      15_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP fixture exited before announcing a port (code ${code})`));
    });
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve((JSON.parse(line) as { port: number }).port);
    });
  });
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    kill: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
};

test("e2e stateful HTTP (child process): two sessions on ONE server process keep their own transport ids", async () => {
  const sink = await startIngestSink();
  const fixture = await spawnHttpFixture(sink.url);
  try {
    const transportSessionIds: string[] = [];
    for (const message of ["first http session", "second http session"]) {
      const transport = new StreamableHTTPClientTransport(fixture.url);
      const client = new Client({ name: "claude-code", version: "9.9.9" });
      await client.connect(transport);
      try {
        await client.callTool({ name: "echo", arguments: { msg: message } });
        assert.ok(transport.sessionId, "server must issue an Mcp-Session-Id");
        transportSessionIds.push(transport.sessionId!);
      } finally {
        await client.close();
      }
    }

    const events = sink.requests.flatMap((r) => r.batch.events);
    const sessionInits = events.filter((e) => e.kind === "session_init");
    assert.equal(sessionInits.length, 2, "one session_init per HTTP session");

    // Hints are exactly the transport-issued ids — never the stdio
    // process-scoped fallback, even though both sessions share one process.
    const hints = new Set(events.map((e) => e.session_id_hint));
    assert.deepEqual([...hints].sort(), [...transportSessionIds].sort());
    for (const hint of hints) {
      assert.ok(!String(hint).startsWith("stdio-"), "stdio fallback leaked into HTTP");
    }
    assert.equal(new Set(events.map((e) => e.actor_id)).size, 1);
  } finally {
    await fixture.kill();
    await sink.close();
  }
});

// ─── Streamable HTTP (stateless / serverless shape) ────────────────────────

// Per-request transport + per-request instrumented server, glued by
// `resolveStatelessHttpSession` — the documented Vercel/Lambda integration.
// The session id is minted at initialize (carrying the client identity) and
// echoed by the client on every later request.
const startStatelessHttpServer = async (
  emit: (batch: AnalyticsIngestBatch) => void,
) => {
  const buildServer = () =>
    withMcpAnalytics({ armature: { delivery: "await", emit } }, () => {
      const s = new McpServer({ name: "e2e-stateless-fixture", version: "0.0.1" });
      s.registerTool(
        "echo",
        { description: "echo", inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: "text" as const, text: msg }] }),
      );
      return s;
    }).result;

  const httpServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      void (async () => {
        if (req.method !== "POST") {
          // Serverless deployments commonly reject GET/DELETE; the client
          // tolerates 405 per spec.
          res.writeHead(405).end();
          return;
        }
        const body = JSON.parse(raw) as unknown;
        const session = resolveStatelessHttpSession({ body, headers: req.headers });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: session.sessionIdGenerator,
          enableJsonResponse: true,
        });
        await buildServer().connect(transport);
        await transport.handleRequest(req, res, body);
      })().catch((error) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
    });
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
};

test("e2e stateless HTTP: identity-bearing session id survives across per-request server instances", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const server = await startStatelessHttpServer((batch) => batches.push(batch));
  try {
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(transport);
    try {
      await client.callTool({ name: "echo", arguments: { msg: "stateless" } });

      const mintedId = transport.sessionId;
      assert.ok(mintedId, "initialize must mint a session id");
      // The id carries the client identity in the documented shape.
      assert.match(mintedId!, /^mcp_claude-code_v_9\.9\.9_[0-9a-f-]{36}$/);

      const events = batches.flatMap((b) => b.events);
      const toolCall = events.find((e) => e.kind === "tool_call");
      const sessionInit = events.find((e) => e.kind === "session_init");
      // The tool call landed on a DIFFERENT server instance than initialize,
      // yet resolves the same session id from the echoed header.
      assert.equal(toolCall?.session_id_hint, mintedId);
      assert.ok(sessionInit, "stateless tool call emits its session_init");
      assert.equal(sessionInit?.session_id_hint, mintedId);
      assert.equal(sessionInit?.metadata.client_name, "claude-code");
      // And it is not the stdio process-scoped fallback.
      assert.ok(!mintedId!.startsWith("stdio-"));
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
});

test("e2e streamable HTTP: the transport session id wins — the stdio fallback must not leak into HTTP", async () => {
  const batches: AnalyticsIngestBatch[] = [];
  const server = await startInstrumentedHttpServer((batch) => batches.push(batch));
  try {
    const client = new Client({ name: "web-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(server.url));
    try {
      await client.callTool({ name: "echo", arguments: { msg: "over http" } });
    } finally {
      await client.close();
    }

    const events = batches.flatMap((b) => b.events);
    const toolCall = events.find((e) => e.kind === "tool_call");
    const sessionInit = events.find((e) => e.kind === "session_init");
    assert.ok(toolCall);
    assert.ok(sessionInit);
    // Real transport-issued id — not a process-scoped stdio fallback.
    assert.equal(toolCall?.session_id_hint, server.sessionId);
    assert.equal(sessionInit?.session_id_hint, server.sessionId);
    assert.equal(sessionInit?.metadata.client_name, "web-agent");
  } finally {
    await server.close();
  }
});
