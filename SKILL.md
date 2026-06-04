---
name: install-mcp-analytics
description: >
  Wire the @armature-tech/mcp-analytics SDK into an existing MCP server so tool calls
  emit telemetry to Armature. Use whenever the user wants to add, install, integrate,
  or instrument analytics on an MCP server — e.g. "add Armature analytics to this MCP",
  "instrument my tools", "wire mcp-analytics into our server". Detects which integration
  shape fits the repo (registry-style McpServer, drop-in factory, dispatcher, or Mastra
  MCPServer), makes the edits, and verifies the wiring by checking the schema includes
  the telemetry block and a test tool call produces an authenticated batch.
---

# Install @armature-tech/mcp-analytics into an MCP server

You are integrating the `@armature-tech/mcp-analytics` SDK into a customer's MCP server
codebase. The SDK decorates each tool's input schema with a `telemetry.*` block (so the
agent can pass `intent`, `context`, `frustration_level`), strips those fields before the
handler runs, and posts an authenticated batch to Armature after each call.

The hard part is picking the right integration shape and not breaking the existing server.
Four shapes exist; pick one based on how the customer's code looks today.

## Step 1: Identify the integration shape

Read enough of the repo to classify it. Grep first; only open files you need.

| Signal | Shape |
| --- | --- |
| `package.json` depends on `@mastra/mcp` or `@mastra/core`, code calls `new MCPServer({ tools })` | **D. Mastra** |
| Code calls `new McpServer(...)` and then `server.registerTool(...)` directly | **A. Drop-in** |
| Code is new / customer wants to define tools through us | **B. Registry-style** |
| Code hand-rolls `tools/list` and `tools/call` handlers, dispatching by name | **C. Dispatcher** |

Mastra (Shape D) check first — it's the only one keyed off a dependency, and `@mastra/mcp`'s
`MCPServer` looks superficially like the SDK's `McpServer` but is a different surface, so
Shapes A–C will not fit. A factory that constructs the MCP SDK's `McpServer` and registers
tools inside is the next most common — that's shape A. Don't ask the user which shape to
pick; figure it out from the code and announce your choice in one line before editing.

If the repo has multiple MCP servers, ask the user which one (use `AskUserQuestion`). Don't
guess.

## Step 2: Install the dependencies

```sh
npm install @armature-tech/mcp-analytics
```

`@modelcontextprotocol/sdk` and `zod` are peer-ish — they should already be in the project.
If they aren't, install them too. Use the customer's package manager (check for
`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` and match it).

The package is published to the public npm registry — `npm install` works without any
`.npmrc` configuration.

## Step 3: Add the API key environment variable

The SDK needs one credential, plus an optional URL override:

| Variable | What it is |
| --- | --- |
| `ANALYTICS_INGEST_API_KEY` | Your Armature API key (created in the dashboard). Identifies the MCP server and signs each batch. |
| `ANALYTICS_INGEST_URL` | Optional. Defaults to the prod endpoint `https://app.armature.tech/api/mcp-analytics/ingest`. Override for a local mock or staging environment. |

Add `ANALYTICS_INGEST_API_KEY` to whatever env mechanism the project uses (`.env.example`,
`wrangler.toml`, `vercel.json`, fly secrets, k8s manifests). Do **not** commit real values;
put a placeholder in `.env.example` and tell the user where to paste the real one.

If `ANALYTICS_INGEST_API_KEY` is missing at runtime, the SDK silently no-ops. That's intentional
for local dev — say so once, don't add guards.

## Step 4: Pick a delivery mode

The default is `delivery: "background"` which schedules the post on `setImmediate`. That
**will drop batches in serverless** because the function exits before the immediate fires.

Use this decision table:

| Runtime | `delivery` |
| --- | --- |
| Vercel / Lambda / Cloudflare Workers / any per-request serverless | `"await"` |
| Long-lived Node process, container, fly machine, persistent server | `"background"` + call `recorder.flush()` on `SIGTERM` |

Detect the runtime from the repo (look for `vercel.json`, `wrangler.toml`, `Dockerfile`,
`fly.toml`, `package.json` scripts). If you're not sure, default to `"await"` — it's the
safe choice and only costs a few ms per call.

## Step 5: Make the edits

### Shape A — Drop-in

Wrap the existing server factory. Don't rewrite tool definitions.

```ts
import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";

// before:
// const server = createMyMcpServer();

// after:
const server = createMcpAnalyticsServer(
  () => createMyMcpServer(),
  {
    armature: {
      // endpointUrl / apiKey default to env vars
      delivery: "await", // or "background" — see Step 4
    },
  },
);
```

If the factory isn't already a function (e.g. the file does `const server = new McpServer(...)`
at module top-level and then `server.registerTool(...)` calls follow), refactor it into a
function first — `createMcpAnalyticsServer` needs to control the call site so the
`AsyncLocalStorage` context is active when `registerTool` runs. One small refactor:

```ts
// before
const server = new McpServer({ name, version });
server.registerTool("foo", ...);
server.registerTool("bar", ...);
export { server };

// after
const createServer = () => {
  const server = new McpServer({ name, version });
  server.registerTool("foo", ...);
  server.registerTool("bar", ...);
  return server;
};
export const server = createMcpAnalyticsServer(createServer);
```

If you need `recorder.flush()` (serverless), use `withMcpAnalytics` instead and call
`await recorder.flush()` at the end of the request handler. Don't sprinkle `flush()` calls
through tool handlers — once per request, at the end, is enough.

### Shape B — Registry-style

The recorder owns the tool registry. Define tools on the recorder, then ask it to build
the server.

```ts
import { createAnalyticsRecorder } from "@armature-tech/mcp-analytics";
import { z } from "zod";

const analytics = createAnalyticsRecorder({
  armature: { delivery: "await" },
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

const server = analytics.createMcpServer({ name: "my-mcp", version });
await server.connect(transport);
```

Use this only on greenfield code. Don't rewrite an existing server into this shape — use
Shape A instead.

### Shape C — Dispatcher

For servers that publish a JSON-Schema tool catalog and route `tools/call` by name without
ever touching `McpServer.registerTool`:

```ts
import { createAnalyticsRecorder } from "@armature-tech/mcp-analytics";

const analytics = createAnalyticsRecorder({
  armature: {
    delivery: "await",
    actorId: ({ ctx }) => (ctx as RequestContext).userProfileId,
  },
});

// Register each tool with the recorder — same definitions you had before.
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
  async (args, { ctx }) => db.customers.lookup(args.customer_id, ctx),
);

// In the tools/list handler:
return { tools: analytics.toolDefinitions() };

// In the tools/call handler:
return await analytics.dispatch(name, rawArgs, { ctx, sessionId });
```

The `sessionId` should come from whatever you already track per-connection (the MCP
session id from the `Mcp-Session-Id` header, your own session table, etc.). If the customer
has no session concept, pass a stable per-connection id — the SDK uses it to fire one
`session_init` event per new session.

### Shape D — Mastra

For servers built on `@mastra/mcp`'s `MCPServer` with tools defined via
`createTool({...})` from `@mastra/core/tools`. The Mastra adapter operates at the **tool
level**: it extends each tool's Zod `inputSchema` with the telemetry block, wraps each
`execute` to strip telemetry from input and emit a batch, and returns a fresh tool map
you pass straight back into `new MCPServer({ tools })`.

```ts
import { wrapMastraTools } from "@armature-tech/mcp-analytics/mastra";

new MCPServer({
  id: "my-mcp",
  name: "My MCP",
  version: "0.0.1",
  tools: wrapMastraTools(createMyTools(), {
    armature: { delivery: "await" },
  }),
  resources: myResources,
});
```

If the server needs `flush()` (long-lived process on `delivery: "background"`) or
shares a recorder across multiple tool maps, use `createMastraAnalytics`:

```ts
import { createMastraAnalytics } from "@armature-tech/mcp-analytics/mastra";

const analytics = createMastraAnalytics({ armature: { delivery: "background" } });
new MCPServer({ tools: analytics.wrapTools(createMyTools()), ... });
process.on("SIGTERM", () => analytics.flush());
```

To propagate `sessionId` / `authInfo` from Mastra's per-call context, pass a
`resolveExtra` callback. Mastra's `execute(inputData, context)` second argument is whatever
the customer's tools already receive — read from it:

```ts
wrapMastraTools(tools, {
  armature: { delivery: "await" },
  resolveExtra: (mastraContext) => ({
    sessionId: (mastraContext as any)?.runtimeContext?.get?.("sessionId"),
    authInfo: (mastraContext as any)?.requestContext?.authInfo,
  }),
});
```

`actorId` is configured the normal way on `config.armature.actorId` — the resolver
receives `ctx` set to Mastra's second-arg context.

The SDK does not import `@mastra/*` at runtime (structural typing), so the adapter
works with whatever Mastra version the customer is on. Do not add `@mastra/*` to
their dependencies — it's already there if Shape D applies.

### Recording session_init at handshake (optional, all shapes)

By default, `session_init` fires the first time a sessionId shows up in `recordToolCall`.
If the customer wants the event to fire at MCP handshake time even when the client never
calls a tool, add this inside the `initialize` JSON-RPC handler:

```ts
await analytics.recordSessionInit({ sessionId, ctx });
```

Only mention this if the customer asks about session tracking, or if their MCP server
already has a custom `initialize` handler — otherwise skip it.

## Step 6: Verify the wiring

Two checks. Don't skip them.

**Check 1 — Schema includes telemetry.** Spin up the server, ask it for `tools/list`, and
confirm one of the tools has a `telemetry` property in its `inputSchema`. If the project
has a dev server script, use it; otherwise write a 10-line script that imports the factory
and calls `server.tool()` listing. Stop and investigate if the schema isn't decorated —
that means the `AsyncLocalStorage` context wasn't active when `registerTool` ran (most
common cause: tools registered outside the factory in Shape A).

**Check 2 — A real tool call produces a batch.** Either:

- Run a tool against the local mock at `http://127.0.0.1:8787/api/mcp-analytics/ingest`
  (set `ANALYTICS_INGEST_URL` to it and run `npm run dev:armature` if the SDK repo is
  checked out locally), or
- Set `armature.emit` in the config to a stub that captures the batch, fire a test tool
  call, and assert the captured batch has one `tool_call` event with the right tool name.

A passing typecheck is not verification. The schema decoration and the authenticated batch are
what matter — verify both.

## Step 7: Mention the gotchas, then stop

Tell the user, briefly:

- `delivery: "background"` drops batches in serverless. You picked `"await"` (or not — say which).
- The SDK no-ops silently if `ANALYTICS_INGEST_API_KEY` is missing. Set it in prod.

Don't pad with anything else. End with one line: what you changed and what the user needs
to do (paste the API key, deploy).

## What NOT to do

- Don't add error handling around `recorder.recordToolCall` — the SDK swallows emit errors
  via `onError`. Wrapping it adds noise.
- Don't add a `try/catch` around `flush()` either. Pass `onError` in config if the user
  wants custom handling.
- Don't expose `ANALYTICS_INGEST_API_KEY` to the client side — it's server-only. If you see it
  imported in a browser bundle path, stop and flag it.
- Don't rewrite tool definitions to "match the SDK style" if Shape A works. Minimum
  change wins.
- Don't add a `MCP_ANALYTICS_ENABLED` feature flag. `armature.enabled: false` already
  exists and the SDK no-ops on missing env vars.
