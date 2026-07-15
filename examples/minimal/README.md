# Minimal TypeScript MCP server

This complete stdio server exposes one `echo` tool and records its tool calls with Armature.

## Run

~~~bash
npm install
ANALYTICS_INGEST_API_KEY="..." npm start
~~~

Launch the command from an MCP client, call `echo`, and open Armature to inspect the session.
