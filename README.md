# Mock Autumn MCP Server

Minimal TypeScript test environment with a mock Autumn MCP server.

## Scripts

- `npm run dev:server` starts the mock Autumn MCP server over stdio.
- `npm run demo` runs an in-memory MCP client against the mock server and prints `tools/list`, `tools/call`, and the mock Autumn call log.
- `npm run typecheck` checks the TypeScript project.

## Current Scope

This repo intentionally contains only the mock Autumn MCP test environment. There is no analytics wrapper, plan document, or SDK implementation here.
