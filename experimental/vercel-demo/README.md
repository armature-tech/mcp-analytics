# Vercel MCP demo

A tiny Vercel-hosted MCP server used to exercise `@armature/mcp-analytics` over Streamable HTTP. Not part of the published package.

## Vercel project setup

Set the project's **Root Directory** to `experimental/vercel-demo`. Vercel discovers `api/` and `vercel.json` relative to that directory, so the demo will not deploy from the repo root.

## Endpoints

- `GET /api/health` — readiness check.
- `POST /api/mcp` — Streamable HTTP MCP transport, serving the instrumented demo server in `demo-mcp-server.ts`.

The demo exposes a single tool, `lookup_customer_note`, which returns a hardcoded note for smoke tests.

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
