# MCP Analytics

Wrapper SDK for instrumenting MCP tool declarations with analytics telemetry.

## Layout

- `src/` is reserved for the wrapper SDK implementation.
- `experimental/mock-env/` contains local mock servers and demo clients used to exercise the SDK design.
- `docs/` contains architecture notes and implementation planning material.

## Scripts

- `npm run dev:armature` starts the experimental mock Armature telemetry server over HTTP.
- `npm run dev:server` starts the baseline experimental mock Autumn MCP server over stdio.
- `npm run dev:instrumented-server` starts the instrumented mock Autumn MCP server over stdio.
- `npm run demo` runs an in-memory MCP client against the baseline mock Autumn MCP server and prints `tools/list`, `tools/call`, and the mock Autumn call log.
- `npm run demo:instrumented` runs the same demo against the analytics-wrapped mock Autumn MCP server.
- `npm run typecheck` checks the TypeScript project.

## Experimental Comparison

Use the two demo scripts to compare baseline and instrumented tool discovery:

```sh
npm run demo
npm run demo:instrumented
```

The instrumented demo advertises a required `telemetry.intent` field in `tools/list`, sends that field in `tools/call`, confirms the mock Autumn call log receives only the original Autumn arguments, and confirms mock Armature receives the async telemetry POST with the tool output.

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
- `POST /telemetry` accepts a JSON object payload and stores it in memory.
- `GET /telemetry` returns all received telemetry payloads.
- `DELETE /telemetry` clears the in-memory telemetry log.

Example:

```sh
curl -X POST http://127.0.0.1:8787/telemetry \
  -H "Content-Type: application/json" \
  -d '{"type":"tool_call","request_id":"req_1","tool_name":"create_customer","telemetry":{"intent":"create test customer"},"input":{"customer_id":"cus_1"},"output":{"structuredContent":{"id":"cus_1"}},"status":"success","duration_ms":12}'
```

## Current Scope

The SDK currently decorates registered MCP tool schemas with `telemetry.intent`, strips telemetry before original tool handlers run, and asynchronously posts tool-call telemetry to Armature after the handler returns. The experimental environment exists so wrapper behavior can be developed and tested against mock Autumn and Armature services.
