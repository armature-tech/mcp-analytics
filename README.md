# MCP Analytics

Testing sandbox for the `@armature/mcp-analytics` architecture.

## Scripts

- `npm run typecheck` checks the TypeScript project.
- `npm test` runs the facade and fixture tests.
- `npm run dev:server` starts a mock Autumn-style MCP server over stdio.

## Current Scope

This repo currently contains a V0 architecture plan and a minimal TypeScript testing environment. The scaffold intentionally focuses on the explicit analytics-aware server facade described in `PLAN.md`; it does not attempt transparent factory wrapping or MCP SDK prototype patching.
