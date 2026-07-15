# Armature MCP Analytics for TypeScript

Understand which MCP tools agents use, what users are trying to accomplish, and where calls fail—without building an observability pipeline.

[![npm version](https://img.shields.io/npm/v/%40armature-tech%2Fmcp-analytics?label=npm)](https://www.npmjs.com/package/@armature-tech/mcp-analytics)
[![CI](https://github.com/armature-tech/mcp-analytics/actions/workflows/ci.yml/badge.svg)](https://github.com/armature-tech/mcp-analytics/actions/workflows/ci.yml)
[![Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[Armature](https://armature.tech) · [Python SDK](https://github.com/armature-tech/mcp-analytics-python) · [Go SDK](https://github.com/armature-tech/mcp-analytics-go) · [Agent install](SKILL.md)

## Install in 30 seconds

### 1. Install

~~~bash
npm install @armature-tech/mcp-analytics @modelcontextprotocol/sdk@^1.29.0 zod
~~~

MCP SDK 1.29 or newer is required when your tools use Zod 4 raw-shape
schemas. MCP SDK 1.20 accepts the package but silently drops fields from those
schemas, including Armature's telemetry field.

### 2. Add your ingest key

Create a server in the [Armature dashboard](https://app.armature.tech), copy its ingest key, and add it to your environment:

~~~bash
export ANALYTICS_INGEST_API_KEY="..."
~~~

### 3. Instrument your MCP server

Wrap the factory that creates your existing **McpServer**:

~~~ts
import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";
import { createMyMcpServer } from "./server.js";

const server = createMcpAnalyticsServer(createMyMcpServer);
~~~

> **That’s it. Make one tool call, open Armature, and the session is already there.**

## Built for MCP—not page views

| Understand demand | Find what breaks | Improve with context |
| --- | --- | --- |
| See which tools and use cases people actually need. | Surface failures, retries, latency, and dead ends. | Connect every call to user intent and agent reasoning. |

No custom event schema. No logging pipeline. No changes to your tool handlers.

## What you see in Armature

- Complete MCP sessions and client attribution
- The user intent behind each session
- Every tool called by the agent
- Input and output previews, latency, and outcome
- Failures, timeouts, and repeated retries
- Cross-server activity for the same actor

## How it works

Armature instruments the boundary around every tool call:

1. The SDK adds an optional **telemetry** block to the tool’s input schema.
2. The agent can attach user intent, reasoning, and frustration to the call.
3. The SDK removes telemetry before your handler receives the arguments.
4. Timing, outcome, and truncated previews are sent to your dashboard.

~~~json
{
  "telemetry": {
    "user_turn": 1,
    "user_intent": "Check whether the customer's last payment succeeded",
    "agent_thinking": "The payment lookup tool provides the requested status",
    "user_frustration": "low"
  }
}
~~~

All telemetry fields are optional. The earlier **intent**, **context**, and **frustration_level** names remain accepted for clients with cached schemas.

> **Privacy:** Armature is observability, not authentication. Keep your existing MCP authentication and authorization in place. Do not put secrets in tool arguments or telemetry fields.

## Choose the integration that matches your server

| Server shape | Integration |
| --- | --- |
| Existing **McpServer** factory | **createMcpAnalyticsServer(factory, config)** |
| Existing server and tool registry | **instrumentMcpServerTools(...)** |
| Custom registry or JSON-RPC dispatcher | **createAnalyticsRecorder(...)** |
| Mastra tool map | **wrapMastraTools(...)** |
| Stateless HTTP or serverless | **resolveStatelessHttpSession(...)** |

### Existing server and tool registry

Use **instrumentMcpServerTools** when you own an existing server instance and a registry of tool definitions:

~~~ts
instrumentMcpServerTools({
  server,
  tools,
  config: {
    armature: {
      delivery: "await",
    },
  },
  mapTool,
});
~~~

This path registers tools directly and works with package layouts where wrapping the server factory is not a fit.

### Custom dispatcher

Use the recorder when you manage **tools/list** and **tools/call** yourself:

~~~ts
import { createAnalyticsRecorder } from "@armature-tech/mcp-analytics";

const analytics = createAnalyticsRecorder({
  armature: {
    delivery: "await",
  },
});

analytics.tool(toolDefinition, toolHandler);

// tools/list
const tools = analytics.toolDefinitions();

// tools/call
const result = await analytics.dispatch(name, args, context);
~~~

### Mastra

~~~ts
import { wrapMastraTools } from "@armature-tech/mcp-analytics/mastra";

const instrumentedTools = wrapMastraTools(tools, {
  armature: {
    delivery: "await",
  },
});
~~~

### Stateless HTTP and serverless

Initialization and tool calls can land on different instances in stateless deployments. **resolveStatelessHttpSession** preserves the MCP client and session identity without a session store:

~~~ts
import { resolveStatelessHttpSession } from "@armature-tech/mcp-analytics";

const session = resolveStatelessHttpSession({
  body: requestBody,
  headers: requestHeaders,
});

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: session.sessionIdGenerator,
  enableJsonResponse: true,
});

await analytics.dispatch(name, args, {
  ...context,
  ...session.dispatchContext,
});
~~~

Use **delivery: "await"** in serverless and short-lived processes.

Client attribution is best-effort observability, not a security boundary. Continue to gate access with real authentication.

## Let your coding agent install it

From your MCP server repository:

~~~bash
npx --yes skills add armature-tech/mcp-analytics
~~~

Then ask Claude Code, Cursor, or Codex:

> Install Armature MCP Analytics using the repository’s SKILL.md. Detect the server shape, instrument it, and verify that a tool-call event is emitted.

The full integration playbook is in [SKILL.md](SKILL.md).

## Configuration

Most servers only need **ANALYTICS_INGEST_API_KEY**. Operational controls are available when you need them:

~~~ts
type McpAnalyticsConfig = {
  armature?: {
    endpointUrl?: string;
    apiKey?: string;
    actorId?: string | ((input) => string | Promise<string>);
    enabled?: boolean;
    delivery?: "background" | "await";
    timeoutMs?: number;
    emit?: (batch) => void | Promise<void>;
    onError?: (error, batch) => void;
  };
};
~~~

| Option | Default | Purpose |
| --- | --- | --- |
| **endpointUrl** | Armature cloud | Override the ingestion endpoint |
| **apiKey** | **ANALYTICS_INGEST_API_KEY** | Authenticate events and identify the MCP server |
| **actorId** | Derived from request auth | Supply a stable user or tenant seed |
| **enabled** | **true** | Enable or disable instrumentation |
| **delivery** | **"background"** | Use **"await"** for serverless or short-lived processes |
| **timeoutMs** | **500** | Set the delivery timeout |
| **emit** | Network emitter | Replace delivery for tests or custom pipelines |
| **onError** | None | Observe delivery failures |

### Delivery

- **"background"** returns tool results immediately and posts events on the next turn of the event loop. Call **await recorder.flush()** during shutdown.
- **"await"** waits for the delivery attempt before returning. Use it for serverless functions and short-lived processes.

If the API key is missing, delivery quietly no-ops for local development.

### Actor identification

By default, the SDK derives an actor seed from request authentication information. You may provide a string or function through **actorId**.

The seed is hashed before transmission. Armature scopes the resulting actor identifier to your server.

## Environment variables

| Variable | Purpose |
| --- | --- |
| **ANALYTICS_INGEST_API_KEY** | Armature ingest key |
| **ANALYTICS_INGEST_URL** | Optional ingestion endpoint override |

## Support

[Open an issue](https://github.com/armature-tech/mcp-analytics/issues) · [Email us](mailto:hey@armature.tech) · [Changelog](CHANGELOG.md)

## License

Licensed under the [Apache License 2.0](LICENSE).
