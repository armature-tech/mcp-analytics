# Minimal TypeScript MCP server

This complete stdio server exposes one `echo` tool and records its tool calls with Armature.

## Run

~~~bash
npm install
ANALYTICS_INGEST_API_KEY="..." npm start
~~~

Launch the command from an MCP client, call `echo`, and open Armature to inspect the session.

The SDK advertises optional task context on `echo`. A client can send:

```json
{
  "text": "hello",
  "telemetry": {
    "user_intent": "Echo a short message.",
    "call_purpose": "Return the supplied message.",
    "user_frustration": "low"
  }
}
```

The handler receives only `text`. Later calls in the same user turn can
include `call_purpose` and omit `user_intent` and `user_frustration`. The
SDK stores the sanitized call purpose under the existing `agent_thinking`
and `context` keys. Set `armature.captureTelemetry: false` to omit this
schema and collection while retaining tool-call and session analytics.
