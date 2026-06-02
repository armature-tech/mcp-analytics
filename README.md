# MCP Analytics

Wrapper SDK for instrumenting MCP tool declarations with analytics telemetry.

## Layout

- `src/` is reserved for the wrapper SDK implementation.
- `experimental/mock-env/` contains local mock servers and demo clients used to exercise the SDK design.
- `experimental/vercel-demo/` contains a tiny Vercel-hosted MCP demo that exercises the SDK wrapper over Streamable HTTP.
- `docs/` contains architecture notes and implementation planning material.

## Scripts

- `npm run dev:armature` starts the experimental mock Armature telemetry server over HTTP.
- `npm run dev:server` starts the baseline experimental mock Autumn MCP server over stdio.
- `npm run dev:instrumented-server` starts the instrumented mock Autumn MCP server over stdio.
- `npm run demo` runs an in-memory MCP client against the baseline mock Autumn MCP server and prints `tools/list`, `tools/call`, and the mock Autumn call log.
- `npm run demo:instrumented` runs the same demo against the analytics-wrapped mock Autumn MCP server.
- `npm run check:vercel-demo` type-checks the experimental Vercel MCP demo.
- `npm run typecheck` checks the TypeScript project.

## Experimental Comparison

Use the two demo scripts to compare baseline and instrumented tool discovery:

```sh
npm run demo
npm run demo:instrumented
```

The instrumented demo advertises a required `telemetry.intent` field plus optional `telemetry.context` and `telemetry.frustration_level` fields in `tools/list`, sends those fields in `tools/call`, confirms the mock Autumn call log receives only the original Autumn arguments, and confirms mock Armature receives the async ingest batch with a `tool_call` event.

## SDK Usage Sketch

```ts
import { createMcpAnalyticsServer } from "@armature/mcp-analytics";

const server = createMcpAnalyticsServer(
  () => createAutumnOperationsMCPServer()
);
```

## Experimental Mock Armature Server

`npm run dev:armature` starts an HTTP server on `http://127.0.0.1:8787`.

- `GET /health` returns a readiness check.
- `POST /api/mcp-analytics/ingest` accepts an mcp-tester-style ingest batch and stores it in memory.
- `POST /telemetry` is kept as a compatibility alias for local experiments.
- `GET /telemetry` returns all received telemetry payloads.
- `DELETE /telemetry` clears the in-memory telemetry log.

Example:

```sh
curl -X POST http://127.0.0.1:8787/api/mcp-analytics/ingest \
  -H "Content-Type: application/json" \
  -d '{"schema_version":1,"events":[{"event_id":"evt_1","kind":"tool_call","mcp_server_id":"srv_1","actor_id":"actor_1","session_id_hint":null,"started_at":"2026-06-02T12:00:00.000Z","finished_at":"2026-06-02T12:00:00.012Z","duration_ms":12,"ok":true,"error":null,"metadata":{"tool_name":"create_customer","intent":"create test customer","context":"demo","frustration_level":"low","input_preview":"{\"customer_id\":\"cus_1\"}"},"script_source":"MCP tool call: create_customer\n\nInput:\n{\"customer_id\":\"cus_1\"}","script_source_truncated":false,"result_preview":"{\"structuredContent\":{\"id\":\"cus_1\"}}","result_truncated":false,"calls":[],"logs":[],"search_calls":[]}]}'
```

## Current Scope

The SDK currently decorates registered MCP tool schemas with telemetry fields, strips telemetry before original tool handlers run, and asynchronously posts signed mcp-tester ingest batches to Armature after the handler returns. Wrapped MCP tool executions emit generic `tool_call` events; Code Mode MCPs should continue to emit `execute_script`.
