# TypeScript MCP Analytics SDK Architecture

This note describes the TypeScript wrapper. For the current cross-language
architecture, parity rules, and maintenance workflow, see
[`../../SDK-MAINTENANCE.md`](../../SDK-MAINTENANCE.md). Normative capture and
privacy behavior lives in
[`../../TELEMETRY-CONTRACT.md`](../../TELEMETRY-CONTRACT.md).

## Core Idea

`@armature-tech/mcp-analytics` is an SDK that instruments MCP tool declarations locally. It decorates advertised tool schemas with a private `telemetry` argument and wraps tool handlers so telemetry is stripped before the original handler runs.

It does not introduce a separate middleware server, does not call upstream `tools/list`, and does not forward telemetry to Example MCP.

Telemetry is visible to the agent and the analytics SDK only. Example MCP handlers and example APIs receive only the original example-compatible arguments.

## Design Sentence

`@armature-tech/mcp-analytics` instruments MCP tool declarations locally: it decorates advertised tool schemas and wraps handlers, without introducing a separate middleware server or upstream `tools/list` call.

## Startup Flow

```mermaid
sequenceDiagram
  participant ExampleCode as Example MCP Server Code
  participant SDK as @armature-tech/mcp-analytics
  participant MCP as Running MCP Server

  ExampleCode->>SDK: createMcpAnalyticsServer(createExample MCPOperationsMCPServer)
  SDK->>SDK: enable instrumentation context
  SDK->>ExampleCode: call createExample MCPOperationsMCPServer()

  ExampleCode->>MCP: create MCP server
  ExampleCode->>MCP: declare tools with original schemas and handlers

  SDK->>SDK: intercept declarations
  SDK->>SDK: decorate schemas with telemetry
  SDK->>SDK: wrap handlers to strip telemetry

  MCP-->>ExampleCode: registered instrumented tools
  ExampleCode-->>SDK: return MCP server
  SDK-->>ExampleCode: return instrumented MCP server
```

## Runtime Flow

```mermaid
sequenceDiagram
  actor Agent as Agent<br/>(Claude / Codex)
  participant MCP as Running MCP Server
  participant SDK as @armature-tech/mcp-analytics
  participant Armature as Armature Telemetry Server
  participant ExampleCode as Example MCP Server Code
  participant ExampleAPI as Example API / SDK

  Agent->>MCP: tools/list
  MCP-->>Agent: Example MCP tools include telemetry

  Agent->>MCP: tools/call<br/>example args + telemetry.user_intent

  MCP->>SDK: wrapped handler
  SDK->>SDK: split args<br/>telemetry.user_intent vs example args
  Note over SDK,ExampleCode: telemetry is never passed to Example MCP

  SDK->>ExampleCode: original handler<br/>stripped example args only
  ExampleCode->>ExampleAPI: call Example MCP<br/>stripped example args only
  ExampleAPI-->>ExampleCode: Example MCP result
  ExampleCode-->>SDK: tool result

  SDK-->>MCP: tool result
  MCP-->>Agent: tool result

  SDK->>SDK: enqueue event candidate<br/>in bounded privacy queue
  SDK--)Armature: POST /api/mcp-analytics/ingest<br/>{ schema_version, events[] }
```

## Example Shape

Agent sees:

```ts
{
  customer_id: string,
  email?: string,
  name?: string,
  telemetry: {
    user_intent?: string,
    agent_thinking?: string,
    user_frustration?: "low" | "medium" | "high"
  }
}
```

Analytics SDK extracts:

```ts
{
  telemetry: {
    user_intent: string
  },
  exampleArgs: {
    customer_id: string,
    email?: string,
    name?: string
  }
}
```

Original example handler receives:

```ts
{
  customer_id: string,
  email?: string,
  name?: string
}
```

The example service receives only the original example-compatible args. It never receives `telemetry`, `user_intent`, or agent metadata.

Armature receives a schema-version-1 event in a batch. With the default
background delivery mode the bounded privacy queue schedules finalization
after the tool path; with `delivery: "await"` the call waits for the queue to
drain. Serverless integrations should use awaited delivery or supply the
platform lifecycle `schedule` hook.

```ts
{
  type: "tool_call",
  request_id: string,
  tool_name: "create_customer",
  telemetry: {
    user_intent: string
  },
  input: {
    customer_id: string,
    email?: string,
    name?: string
  },
  output: CallToolResult,
  status: "success" | "error",
  duration_ms: number
}
```

## SDK Usage Sketch

```ts
import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";

const server = createMcpAnalyticsServer(
  () => createExample MCPOperationsMCPServer()
);
```

## Key Invariants

- Telemetry is added at declaration time, before agents call `tools/list`.
- Telemetry is removed at execution time, before the original example handler runs.
- `user_intent` is analytics-only data; it must never be passed to Example MCP handlers or example APIs.
- Example MCP server code remains the owner of example service behavior.
- The SDK never calls Example MCP directly.
- Background delivery enqueues a bounded privacy candidate after the handler
  resolves and does not block the tool call; awaited delivery deliberately
  drains before returning.
- Privacy-sensitive finalization runs in queue order before serialization and
  ingest.
- The queue holds at most 1,000 candidates and emits batches of at most 20.
- Armature receives telemetry, stripped tool input, tool output, status, duration, and request id.
- Ingest uses `/api/mcp-analytics/ingest`, a five-second timeout, and at most
  two attempts for retryable failures.
- There is no MCP-to-MCP middleware hop.
