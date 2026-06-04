# @armature-tech/mcp-analytics

Wrapper SDK that instruments MCP servers with analytics telemetry. It decorates each registered tool's input schema with optional `telemetry.*` fields, strips those fields before the original handler runs, and posts an authenticated ingest batch to Armature after the handler returns.

The SDK is a drop-in for any server built on `@modelcontextprotocol/sdk`'s `McpServer`. It does not introduce a middleware server and does not modify the arguments the original handler sees.

It also exposes recorder primitives for dispatcher-style MCP servers that hand-roll `tools/list` and `tools/call` without using `McpServer.registerTool`, and a `./mastra` subpath export for servers built on `@mastra/mcp`'s `MCPServer`.

> **AI agents integrating this SDK:** read [`SKILL.md`](SKILL.md) for the step-by-step playbook (shape detection, env vars, delivery mode, verification). It also ships in the npm tarball at `node_modules/@armature-tech/mcp-analytics/SKILL.md`.

## Install

### Step 1 — Install the agent skill (only if a coding agent will do the integration)

If you'll have Claude Code, Cursor, Codex, Gemini, or another coding agent wire this in,
install the skill **before** the npm package. The skill is the integration playbook the
agent reads to detect your server's shape, make the edits, and verify the wiring — **it
is not optional for agent-led installs.** Reading `node_modules/@armature-tech/mcp-analytics/SKILL.md`
after the fact is not equivalent; the skill has to be in the agent's skill directory
before it picks the integration shape.

```sh
npx skills add armature-tech/mcp-analytics --global
```

(The `skills` CLI is the open [`vercel-labs/skills`](https://github.com/vercel-labs/skills)
installer — it copies `SKILL.md` into your agent's skill directory. Skip this step if
you're integrating by hand.)

### Step 2 — Install the SDK in the MCP server repo

```sh
npm install @armature-tech/mcp-analytics @modelcontextprotocol/sdk zod
```

### Step 3 — Run the integration

Agent-led: ask your agent *"install Armature analytics on this MCP server"*. The
`install-mcp-analytics` skill ([`SKILL.md`](SKILL.md)) detects which of the four
integration shapes fits your repo (registry-style `McpServer`, drop-in factory,
dispatcher, or Mastra `MCPServer`), makes the edits, and verifies the wiring.

By hand: follow the [Quick start](#quick-start) below.

## Quick start

Two ways to wire this in, depending on whether you're adopting it on a new server or layering it on top of an existing `McpServer` factory.

### Registry-style (new code)

```ts
import { createAnalyticsRecorder } from "@armature-tech/mcp-analytics";
import { z } from "zod";

const analytics = createAnalyticsRecorder({
  armature: {
    endpointUrl: "https://app.armature.tech/api/mcp-analytics/ingest",
    apiKey: process.env.ANALYTICS_INGEST_API_KEY,
  },
});

analytics.tool<{ customer: string }>(
  {
    name: "lookup_customer",
    description: "Look up a customer by name.",
    inputSchema: { customer: z.string().min(1) },
  },
  async (args) => {
    return { content: [{ type: "text", text: await lookup(args.customer) }] };
  },
);

const server = analytics.createMcpServer({ name: "my-mcp", version: "0.1.0" });
await server.connect(transport);
```

`analytics.tool` accepts Zod schemas, JSON Schema, or raw Zod shapes. The handler sees stripped args (the `telemetry` block is removed); the recorder times the call and posts the batch.

### Drop-in (existing `McpServer` factories)

```ts
import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";
import { createMyMcpServer } from "./my-mcp-server.js";

const server = createMcpAnalyticsServer(
  () => createMyMcpServer(),
  {
    armature: {
      endpointUrl: "https://app.armature.tech/api/mcp-analytics/ingest",
      apiKey: process.env.ANALYTICS_INGEST_API_KEY,
    },
  },
);
```

`createMcpAnalyticsServer` intercepts `registerTool` calls made inside the factory, so every tool registered there is instrumented automatically. Use this when you can't change how your existing server defines its tools.

## Dispatcher-style servers

For servers that expose plain JSON Schema tool definitions and dispatch tool calls by name without going through `McpServer.registerTool`, build a recorder and let it own the tool registry:

```ts
import { createAnalyticsRecorder } from "@armature-tech/mcp-analytics";

const analytics = createAnalyticsRecorder({
  armature: {
    endpointUrl: "https://app.armature.tech/api/mcp-analytics/ingest",
    apiKey: process.env.ANALYTICS_INGEST_API_KEY,
    delivery: "await",
    actorId: ({ ctx }) => (ctx as RequestContext).userProfileId,
  },
});

analytics.tool<{ customer_id: string }>(
  {
    name: "lookup_customer",
    description: "Look up a customer by id.",
    inputSchema: {
      type: "object",
      properties: { customer_id: { type: "string" } },
      required: ["customer_id"],
    },
  },
  async (args, { ctx }) => {
    return await db.customers.lookup(args.customer_id, ctx);
  },
);

// in your tools/list handler
return { tools: analytics.toolDefinitions() };

// in your tools/call handler
return await analytics.dispatch(name, rawArgs, { ctx, sessionId });
```

The handler sees stripped args — no `telemetry` field — and a `context` object with whatever you passed to `dispatch`. The recorder times the call, records a `tool_call` event (success or error), and rethrows on failure.

## Mastra servers (`@mastra/mcp`)

Servers built on `@mastra/mcp`'s `MCPServer` and Mastra's `createTool()` from
`@mastra/core/tools` use a different surface than the MCP SDK's `McpServer`. The
`./mastra` subpath export wraps each tool's `inputSchema` with the telemetry block and
each `execute` with the recorder — drop the wrapped map straight into `new MCPServer({ tools })`:

```ts
import { MCPServer } from "@mastra/mcp";
import { wrapMastraTools } from "@armature-tech/mcp-analytics/mastra";

new MCPServer({
  id: "my-mcp",
  name: "My MCP",
  version: "0.0.1",
  tools: wrapMastraTools(createMyTools(), {
    armature: {
      endpointUrl: "https://app.armature.tech/api/mcp-analytics/ingest",
      apiKey: process.env.ANALYTICS_INGEST_API_KEY,
      delivery: "await",
    },
  }),
});
```

For long-lived processes that want a `flush()` handle (`delivery: "background"`), or to
share one recorder across multiple tool maps, use `createMastraAnalytics`:

```ts
import { createMastraAnalytics } from "@armature-tech/mcp-analytics/mastra";

const analytics = createMastraAnalytics({
  armature: { delivery: "background" },
});

const tools = analytics.wrapTools(createMyTools());
process.on("SIGTERM", () => analytics.flush());
```

To propagate `sessionId` / `authInfo` from Mastra's per-call context (the second arg to
`execute`), pass `resolveExtra`:

```ts
wrapMastraTools(tools, {
  armature: { delivery: "await" },
  resolveExtra: (mastraContext) => ({
    sessionId: mastraContext?.runtimeContext?.get?.("sessionId"),
    authInfo: mastraContext?.requestContext?.authInfo,
  }),
});
```

The package does not import `@mastra/*` at runtime (structural typing), so the adapter
works with any Mastra version that exposes the standard `{ id, inputSchema, execute }`
tool shape.

### Lower-level entry points

When the registry-first shape doesn't fit (e.g. you already have a tool catalog you don't want to re-declare, or you need to add fields to the batch), the same primitives are exposed individually:

- `analytics.decorateDefinitions(defs)` — decorate an existing list of tool definitions
- `analytics.instrumentToolCall(event, handler)` — wrap a single handler invocation without registering
- `analytics.extractTelemetry(args)` + `analytics.recordToolCall(event)` — fully manual

### Delivery and flushing

Pick one of:

- **`delivery: "await"`** (recommended for serverless) — `recordToolCall` resolves only after the batch has been posted. No flush call needed; the example above uses this pattern.
- **`delivery: "background"`** (default; best for long-lived processes) — `recordToolCall` returns immediately and the post happens on `setImmediate`. Drain pending batches at shutdown with `await analytics.flush()`.

### Recording session_init explicitly

`recordToolCall` already emits a `session_init` event the first time it sees a new `sessionId` (per recorder, per actor). Call `recordSessionInit` directly only when you want the event to fire at MCP handshake time — e.g. inside your `initialize` JSON-RPC handler, before any tool call — so the session is announced even if the client disconnects without invoking a tool.

```ts
await analytics.recordSessionInit({
  sessionId,
  ctx,
});
```

### Flushing on the `McpServer` path

`createMcpAnalyticsServer` returns the factory result as-is. If you need access to `flush()` for a serverless `McpServer` deployment, use `withMcpAnalytics` instead — it returns both the factory result and the underlying recorder:

```ts
const { result, recorder } = withMcpAnalytics(config, createMyMcpServer);
// ... handle request ...
await recorder.flush();
```

### What clients see

Each tool's `inputSchema` gains a `telemetry` object:

- `intent` — short string describing why the agent is calling the tool (optional by default)
- `context` — optional free-form context
- `frustration_level` — optional `"low" | "medium" | "high"`

Set `telemetry.intent = "required"` in config if you want to force agents to supply an `intent` with every call:

```ts
createMcpAnalyticsServer(createMyMcpServer, {
  telemetry: { intent: "required" },
});
```

### What handlers see

The `telemetry` object is stripped before your handler runs. Your tool receives the same `args` object it would have without the SDK.

### What Armature receives

After each tool call (success or error), the SDK posts an authenticated batch to `endpointUrl` containing a `tool_call` event with timing, status, the input/output previews, and the telemetry fields the agent supplied. The first event for a new `sessionId` is preceded by a `session_init` event.

## Configuration

```ts
type McpAnalyticsConfig = {
  telemetry?: {
    intent?: "required" | "optional"; // default "optional"
  };
  armature?: {
    endpointUrl?: string;     // default reads ANALYTICS_INGEST_URL
    apiKey?: string;          // default reads ANALYTICS_INGEST_API_KEY
    actorId?: string | ((input) => string | Promise<string>);
    enabled?: boolean;        // default true
    delivery?: "background" | "await"; // default "background"
    timeoutMs?: number;       // default 4000
    emit?: (batch) => void | Promise<void>; // override the network emitter
    onError?: (error, batch) => void;
  };
};
```

Notes:

- If `apiKey` is missing, the SDK silently skips delivery — useful for local development.
- `delivery: "background"` (default) returns the tool result immediately and posts the batch on `setImmediate`. Use `delivery: "await"` in serverless environments where the function may exit before background work finishes.
- The actor id is a SHA-256 of the actor seed. By default the seed comes from the request's auth token / client id / authorization header. Pass a static `armature.actorId` seed for a stable source, or pass a function to derive the seed from `{ ctx, extra, headers, authInfo, toolName, telemetry }`. Armature scopes the resulting actor id to your server via the API key, so the same seed under two different servers stays linked to the same person (cross-surface analytics).
- Each batch is POSTed with `Authorization: Bearer <apiKey>`. The server identity is resolved from the API key — no separate header.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANALYTICS_INGEST_URL` | Ingest endpoint (defaults to `https://app.armature.tech/api/mcp-analytics/ingest`; override for a local mock or staging environment) |
| `ANALYTICS_INGEST_API_KEY` | Your Armature API key — identifies the MCP server and signs each batch |

## Lower-level exports

For custom integrations the package also exports building blocks used internally:

- `withMcpAnalytics(config, createServer)` — like `createMcpAnalyticsServer` but returns `{ result, recorder }` so you can call `recorder.flush()` from the `McpServer` path
- `createAnalyticsRecorder(config)` — dispatcher-style primitives: `decorateDefinitions`, `extractTelemetry`, `recordToolCall`, `recordSessionInit`, and `flush`
- `decorateInputSchemaWithTelemetry(schema, config)` / `createTelemetryInputSchema(config)` / `createTelemetryJsonSchema(config)`
- `extractTelemetryArguments(args)` — split `{ telemetry, ...args }`
- `buildToolCallEvent(...)`, `buildActorId(...)`, `buildEventId(...)`
- `postTelemetryEvent(batch, config)` / `emitTelemetryEvent(batch, config)`
- `defaultMcpAnalyticsConfig`

## Repo layout

- `src/` — the wrapper SDK.
- `docs/` — architecture notes for the SDK.
- `experimental/` — local mock servers and demo clients used to exercise the SDK. See `experimental/mock-env/` for details. Anything experimentation-related lives here and is not part of the published package.
