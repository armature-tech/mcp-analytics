import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolveStatelessHttpSession, withMcpAnalytics } from "@armature-tech/mcp-analytics";

const packageName = "typescript";
const deployment = process.env.SDK_CANARY_DEPLOYMENT || "unknown";
const intent = deployment.startsWith("sdk-canary/")
  ? deployment
  : `sdk-canary/${packageName}/${deployment}`;

const readBody = async req => {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "null");
};

const text = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end();
    return;
  }

  // Canary workflow traffic must remain visible in the test org's Sessions
  // UI. Production servers keep this header so synthetic workflow traffic is
  // excluded; this dedicated endpoint deliberately exercises the user-session
  // analytics path instead.
  const workflowRunId = req.headers["x-armature-workflow-run-id"];
  delete req.headers["x-armature-workflow-run-id"];
  if (typeof workflowRunId === "string" && workflowRunId) {
    req.headers["x-armature-session-seed"] = workflowRunId;
  }
  const body = await readBody(req);
  const session = resolveStatelessHttpSession({ body, headers: req.headers });
  const instrumented = withMcpAnalytics({
    armature: {
      apiKey: process.env.SDK_CANARY_INGEST_KEY,
      endpointUrl: `${process.env.SDK_CANARY_PLATFORM_URL || "https://app.armature.tech"}/api/mcp-analytics/ingest`,
      delivery: "await",
      timeoutMs: 10_000,
      actorId: "sdk-canary-browser-worker",
    },
  }, () => {
    const server = new McpServer({ name: "sdk-canary-typescript", version: deployment });
    server.registerTool("canary_identity", {
      description: `Call exactly once to get this MCP session identity. Reuse the result; do not retry or call this tool again. Set telemetry.user_intent exactly to ${intent}.`,
      inputSchema: {},
    }, async () => text({
      package: packageName,
      deployment,
      session_id: session.sessionId,
      next_step: "Call canary_echo exactly once. Do not call canary_identity again.",
    }));
    server.registerTool("canary_echo", {
      description: "Call exactly once after canary_identity to echo a marker. Omit telemetry.user_intent because this continues the same user turn.",
      inputSchema: { marker: z.string() },
    }, async ({ marker }) => text({ marker, session_id: session.sessionId, deployment }));
    return server;
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: session.sessionIdGenerator,
    enableJsonResponse: true,
  });
  await instrumented.result.connect(transport);
  await transport.handleRequest(req, res, body);
  await instrumented.recorder.flush();
}
