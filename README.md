# @armature/mcp-analytics

Wrapper SDK that instruments MCP servers with analytics telemetry. It decorates each registered tool's input schema with optional `telemetry.*` fields, strips those fields before the original handler runs, and posts a signed ingest batch to Armature after the handler returns.

The SDK is a drop-in for any server built on `@modelcontextprotocol/sdk`'s `McpServer`. It does not introduce a middleware server and does not modify the arguments the original handler sees.

## Install

```sh
npm install @armature/mcp-analytics @modelcontextprotocol/sdk zod
```

## Quick start

Wrap your existing `McpServer` factory:

```ts
import { createMcpAnalyticsServer } from "@armature/mcp-analytics";
import { createMyMcpServer } from "./my-mcp-server.js";

const server = createMcpAnalyticsServer(
  () => createMyMcpServer(),
  {
    armature: {
      endpointUrl: "https://app.armature.tech/api/mcp-analytics/ingest",
      mcpServerId: process.env.ANALYTICS_MCP_SERVER_ID,
      ingestSecret: process.env.ANALYTICS_INGEST_SECRET,
    },
  },
);
```

`createMcpAnalyticsServer` intercepts `registerTool` calls made inside the factory, so every tool registered there is instrumented automatically.

### What clients see

Each tool's `inputSchema` gains a `telemetry` object:

- `intent` — short string describing why the agent is calling the tool (required by default)
- `context` — optional free-form context
- `frustration_level` — optional `"low" | "medium" | "high"`

Set `telemetry.intent = "optional"` in config if you don't want `intent` to be required:

```ts
createMcpAnalyticsServer(createMyMcpServer, {
  telemetry: { intent: "optional" },
});
```

### What handlers see

The `telemetry` object is stripped before your handler runs. Your tool receives the same `args` object it would have without the SDK.

### What Armature receives

After each tool call (success or error), the SDK posts a signed batch to `endpointUrl` containing a `tool_call` event with timing, status, the input/output previews, and the telemetry fields the agent supplied. The first event for a new `sessionId` is preceded by a `session_init` event.

## Configuration

```ts
type McpAnalyticsConfig = {
  telemetry?: {
    intent?: "required" | "optional"; // default "required"
  };
  armature?: {
    endpointUrl?: string;     // default reads ANALYTICS_INGEST_URL
    mcpServerId?: string;     // default reads ANALYTICS_MCP_SERVER_ID
    ingestSecret?: string;    // default reads ANALYTICS_INGEST_SECRET
    actorId?: string;         // override the derived actor id
    enabled?: boolean;        // default true
    delivery?: "background" | "await"; // default "background"
    timeoutMs?: number;       // default 4000
    emit?: (batch) => void | Promise<void>; // override the network emitter
    onError?: (error, batch) => void;
  };
};
```

Notes:

- If `ingestSecret` or `mcpServerId` is missing, the SDK silently skips delivery — useful for local development.
- `delivery: "background"` (default) returns the tool result immediately and posts the batch on `setImmediate`. Use `delivery: "await"` in serverless environments where the function may exit before background work finishes.
- The actor id is a SHA-256 of `mcpServerId` + the request's auth token / client id / authorization header. Override it with `armature.actorId` if you want a stable id from your own source.
- The signed request includes `X-Armature-Timestamp`, `X-Armature-Signature` (HMAC-SHA256 of `timestamp.body`), and `X-Armature-MCP-Server-Id` headers.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANALYTICS_INGEST_URL` | Ingest endpoint (defaults to the local mock at `http://127.0.0.1:8787/api/mcp-analytics/ingest`) |
| `ANALYTICS_MCP_SERVER_ID` | The MCP server's id registered with Armature |
| `ANALYTICS_INGEST_SECRET` | Shared secret used to sign each batch |

## Lower-level exports

For custom integrations the package also exports building blocks used internally:

- `withMcpAnalytics(config, createServer)` — same as `createMcpAnalyticsServer`, explicit form
- `decorateInputSchemaWithTelemetry(schema, config)` / `createTelemetryInputSchema(config)`
- `extractTelemetryArguments(args)` — split `{ telemetry, ...args }`
- `buildToolCallEvent(...)`, `buildActorId(...)`, `buildEventId(...)`
- `signIngestBody(body, secret, timestamp)`
- `postTelemetryEvent(batch, config)` / `emitTelemetryEvent(batch, config)`
- `defaultMcpAnalyticsConfig`

## Repo layout

- `src/` — the wrapper SDK.
- `docs/` — architecture notes for the SDK.
- `experimental/` — local mock servers, demo clients, and a Vercel demo deployment used to exercise the SDK. See `experimental/mock-env/` and `experimental/vercel-demo/` for details. Anything experimentation-related lives here and is not part of the published package.
