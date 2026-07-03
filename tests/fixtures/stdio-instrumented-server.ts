// Real stdio fixture for the transport-level e2e suite: an instrumented
// McpServer connected to an actual StdioServerTransport, spawned as a child
// process by tests/e2e-stdio-transport.test.ts the same way `claude -p`
// spawns MCP servers. Telemetry is posted over HTTP to the sink the test
// passes via env — no emit hook can cross the process boundary, which is
// exactly the blind spot that let the null-session_id_hint bug ship.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMcpAnalyticsServer } from "../../src/index.js";

const endpointUrl = process.env.ANALYTICS_INGEST_URL;
const apiKey = process.env.ANALYTICS_INGEST_API_KEY;
if (!endpointUrl || !apiKey) {
  throw new Error("fixture requires ANALYTICS_INGEST_URL and ANALYTICS_INGEST_API_KEY");
}

const server = createMcpAnalyticsServer(
  () => {
    const s = new McpServer({ name: "e2e-stdio-fixture", version: "0.0.1" });
    s.registerTool(
      "echo",
      { description: "echo the message back", inputSchema: { msg: z.string() } },
      async ({ msg }) => ({ content: [{ type: "text" as const, text: msg }] }),
    );
    return s;
  },
  // delivery "await" makes each tool-call response wait for its telemetry
  // POST, so the test can assert on the sink as soon as callTool resolves.
  { armature: { endpointUrl, apiKey, delivery: "await" } },
);

await server.connect(new StdioServerTransport());
