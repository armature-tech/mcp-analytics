// Real stateful Streamable HTTP fixture for the transport-level e2e suite:
// one long-lived child process serving MANY MCP sessions, each on its own
// transport keyed by Mcp-Session-Id — the standard SDK deployment pattern.
// This is the exact shape the stdio process-scoped fallback must never leak
// into: distinct sessions in one process have to keep their transport ids.
// Telemetry is posted over HTTP to the sink the test passes via env, and the
// chosen port is announced as a JSON line on stdout.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMcpAnalyticsServer } from "../../src/index.js";

const endpointUrl = process.env.ANALYTICS_INGEST_URL;
const apiKey = process.env.ANALYTICS_INGEST_API_KEY;
if (!endpointUrl || !apiKey) {
  throw new Error("fixture requires ANALYTICS_INGEST_URL and ANALYTICS_INGEST_API_KEY");
}

const buildInstrumentedServer = () =>
  createMcpAnalyticsServer(
    () => {
      const s = new McpServer({ name: "e2e-http-fixture", version: "0.0.1" });
      s.registerTool(
        "echo",
        { description: "echo the message back", inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: "text" as const, text: msg }] }),
      );
      return s;
    },
    // delivery "await": each tool-call response waits for its telemetry POST.
    { armature: { endpointUrl, apiKey, delivery: "await" } },
  );

const transportsBySessionId = new Map<string, StreamableHTTPServerTransport>();

const handle = async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
  const sessionId = Array.isArray(req.headers["mcp-session-id"])
    ? req.headers["mcp-session-id"][0]
    : req.headers["mcp-session-id"];
  const existing = sessionId ? transportsBySessionId.get(sessionId) : undefined;
  if (existing) {
    await existing.handleRequest(req, res, body);
    return;
  }

  // No known session: treat as a fresh initialize on a new transport.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      transportsBySessionId.set(id, transport);
    },
  });
  await buildInstrumentedServer().connect(transport);
  await transport.handleRequest(req, res, body);
};

const httpServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    void handle(req, res, raw ? JSON.parse(raw) : undefined).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
});

httpServer.listen(0, "127.0.0.1", () => {
  const { port } = httpServer.address() as AddressInfo;
  // The parent test reads this line to find us.
  process.stdout.write(`${JSON.stringify({ port })}\n`);
});
