# Vercel MCP demo

A tiny Vercel-hosted MCP server used to exercise `@armature-tech/mcp-analytics` over Streamable HTTP. Not part of the published package.

## Vercel project setup

Set the project's **Root Directory** to `experimental/vercel-demo`. Vercel discovers `api/` and `vercel.json` relative to that directory, so the demo will not deploy from the repo root.

## Endpoints

- `GET /api/health` — readiness check.
- `POST /api/mcp` — Streamable HTTP MCP transport, serving the instrumented `McpServer` in `demo-mcp-server.ts` via `createMcpAnalyticsServer`.
- `POST /api/mcp-dispatcher` — hand-rolled JSON-RPC dispatcher in `dispatcher-mcp-handler.ts`, exercising `createAnalyticsRecorder` directly. Both endpoints expose the same `lookup_customer_note` tool so analytics output is comparable across integration styles.

The demo exposes a single tool, `lookup_customer_note`, which returns a hardcoded note for smoke tests.

The dispatcher endpoint accepts a `Bearer <organizationId>:<userProfileId>` header to populate the per-request context; the recorder derives the actor id from `userProfileId`. Pass an `mcp-session-id` header to control the session id (otherwise the handler generates one).

## Analytics environment variables

When these Production env vars are present, the demo posts signed mcp-tester ingest batches to Armature:

```sh
ANALYTICS_INGEST_URL=https://app.armature.tech/api/mcp-analytics/ingest
ANALYTICS_MCP_SERVER_ID=<mcp_tester_server_id>
ANALYTICS_INGEST_SECRET=<ingest_token_secret>
```

The demo config uses `delivery: "await"` with a 15 second timeout so a smoke-test tool call only returns after the signed ingest POST finishes — appropriate for serverless, where the function may otherwise exit before background delivery completes.

## Typecheck

From the repo root:

```sh
npm run typecheck
```
