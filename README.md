# @armature-tech/mcp-analytics

[Armature](https://app.armature.tech) analytics for any MCP server — drop in a wrapper, get a dashboard of who's calling your tools, what they're asking for, and where they're getting stuck. On Armature you can see:

- Who your users are and which tools they actually use
- What agents are *trying* to accomplish (intent, context, frustration captured per call)
- Where tools fail, time out, or get retried
- Cross-server activity for the same user, even across vendors

All this without rolling your own logging pipeline, schema, or auth.

## Getting Started

**Cloud:** sign in at [app.armature.tech](https://app.armature.tech), create a server, copy the API key.

**Install the SDK** in your MCP server repo:

```sh
npm install @armature-tech/mcp-analytics @modelcontextprotocol/sdk zod
```

**Wrap your server** (the most common shape — an existing `McpServer` factory):

```ts
import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";
import { createMyMcpServer } from "./my-mcp-server.js";

const server = createMcpAnalyticsServer(() => createMyMcpServer(), {
  armature: {
    endpointUrl: "https://app.armature.tech/api/mcp-analytics/ingest",
    apiKey: process.env.ANALYTICS_INGEST_API_KEY,
  },
});
```

That's it. Every tool registered inside your factory is now instrumented. Open the dashboard and the first tool call shows up.

> Don't want to wire it up yourself? Ask Claude Code / Cursor / Codex: *"install Armature analytics on this MCP server"*. Run `npx skills add armature-tech/mcp-analytics --global` first so the agent picks up our [integration playbook](SKILL.md) — it detects which of the four shapes your repo uses and edits the right files.

## Why mcp-analytics

**1) Generic analytics don't understand MCP.**

An MCP tool call has structure that page-view analytics throws away: the tool name, the args the agent constructed, whether the call succeeded, what the agent was *trying to do*. You want those as first-class fields, not buried in custom dimensions.

**2) Instrumenting by hand is the same boilerplate every time.**

Decorate input schemas, strip telemetry fields before the handler runs, time the call, batch, retry, dedupe sessions, propagate auth. Every MCP server reinvents it. This package is that boilerplate, packaged once.

**3) The agent should be able to tell you what it's doing.**

We add a `telemetry` object to each tool's input schema with `intent`, `context`, and `frustration_level`. Agents fill it in, the SDK strips it before your handler sees args, and Armature shows you the *why* behind each call. Optional by default — set `telemetry: { intent: "required" }` to force it.

## How it works

Three things happen on every tool call:

1. **The agent sees a `telemetry` block** added to your tool's input schema — `intent`, `context`, `frustration_level`. Optional by default; set `telemetry: { intent: "required" }` to force it.
2. **Your handler sees its original args.** The SDK strips `telemetry` before invoking it.
3. **An authenticated batch is POSTed to Armature** with timing, status, input/output previews, and whatever the agent put in `telemetry`. The first call on a new `sessionId` is preceded by a `session_init` event.

## Other integration shapes

`createMcpAnalyticsServer` covers most repos. If yours doesn't fit, there are three other entry points — the [agent skill](SKILL.md) picks the right one automatically:

- **Registry-style** — `createAnalyticsRecorder()` + `analytics.tool(...)` + `analytics.createMcpServer(...)`. Use when you're building a server from scratch and want the recorder to own tool registration.
- **Dispatcher-style** — same recorder, but you call `analytics.toolDefinitions()` from your `tools/list` handler and `analytics.dispatch(name, args, ctx)` from `tools/call`. For servers that hand-roll the JSON-RPC layer.
- **Mastra** — `wrapMastraTools(tools, config)` from `@armature-tech/mcp-analytics/mastra`. Drop the wrapped map into `new MCPServer({ tools })`.

Code examples for all three live in [`SKILL.md`](SKILL.md).

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

**Delivery mode.** `"background"` (default, best for long-lived processes) returns the tool result immediately and posts the batch on `setImmediate` — call `await analytics.flush()` at shutdown. `"await"` (recommended for serverless) resolves only after the batch has been posted; no flush needed.

**Actor id.** A SHA-256 of an actor seed. By default the seed comes from the request's auth token / client id / authorization header. Pass a static `armature.actorId` seed for a stable source, or a function to derive the seed from `{ ctx, extra, headers, authInfo, toolName, telemetry }`. Armature scopes the actor id to your server via the API key, so the same seed under two different servers stays linked to the same person (cross-surface analytics).

**Missing API key.** The SDK silently skips delivery — useful for local development.

**Auth.** Each batch is POSTed with `Authorization: Bearer <apiKey>`. Server identity is resolved from the API key — no separate header.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANALYTICS_INGEST_URL` | Ingest endpoint (defaults to `https://app.armature.tech/api/mcp-analytics/ingest`; override for a local mock or staging) |
| `ANALYTICS_INGEST_API_KEY` | Your Armature API key — identifies the MCP server and signs each batch |

## More

- **Custom integrations** — `withMcpAnalytics`, `createAnalyticsRecorder`, `decorateInputSchemaWithTelemetry`, and other lower-level primitives are exported for cases the four shapes don't cover. See [`docs/`](docs/) and the source.
- **Recording `session_init` explicitly** — `recordToolCall` already emits one on the first call per `sessionId`. Call `analytics.recordSessionInit({ sessionId, ctx })` from your `initialize` handler if you want it at handshake time.
- **Flushing on the `McpServer` path** — use `withMcpAnalytics(config, createServer)` instead of `createMcpAnalyticsServer`; it returns `{ result, recorder }` so you can `await recorder.flush()`.
- **AI agents integrating this** — read [`SKILL.md`](SKILL.md) (also shipped in the npm tarball).
- **Support** — `hey@armature.tech` or open an issue.
