# Changelog

## 0.2.4

### Session ID header fallback

`normalizeSessionId` now falls back to the `Mcp-Session-Id` request header
when neither `event.sessionId` nor `extra.sessionId` is set. Integrators whose
transport handler forwards `extra.requestInfo.headers` (the same shape already
consumed for `user-agent` / actor context) get correct per-session attribution
automatically, instead of every `tool_call` landing in the ingest service's
per-actor 24h fallback bucket (`fallback:<actorId>:<utc-day>`). Header lookup
is case-insensitive, handles `Headers` instances and Node's
`IncomingHttpHeaders` `string | string[]` shape, and treats empty /
whitespace-only values as absent. Callers that explicitly pass `sessionId`
are unaffected — the explicit value still wins (and is trimmed). The
underlying `headerValue` helper in `utils.ts` is now fully case-insensitive
on plain-object header bags, which also improves `user-agent` extraction for
non-Node header shapes.

### Harness capture on `session_init`

`session_init` events previously hardcoded `client_version`,
`protocol_version`, and `capabilities` to `null`, and read `client_name`
from `authInfo.clientId` (the OAuth client id) rather than from the MCP
`initialize` handshake's `clientInfo`. The Armature ingest server's
`upsertSessionInit` and `extractHarness` paths were already wired to consume
these fields, so the data simply never reached them.

This release adds an optional `clientInfo` field — typed as `McpClientInfo`
(`name`, `version`, `protocolVersion`, `capabilities`) and exported from the
package — as a top-level property on `RecordSessionInitEvent`,
`RecordToolCallEvent`, `InstrumentToolCallEvent`, and `ToolHandlerContext`.
When supplied, `buildSessionInitEvent` populates:

- `client_name` from `clientInfo.name` (trimmed), falling back to
  `extra.authInfo.clientId` for OAuth-only integrators who don't capture the
  handshake yet — no regression.
- `client_version` from `clientInfo.version` (trimmed).
- `protocol_version` from `clientInfo.protocolVersion` (trimmed).
- `capabilities` from `clientInfo.capabilities`, dropped to `null` if the
  serialized payload exceeds 4 KB (mirrors the ingest server's
  `MAX_CAPABILITIES_BYTES` cap so a hostile payload can't bloat the batch
  body — dropped rather than truncated so the field stays valid JSON).

`clientInfo` is threaded through `buildBatch` and `buildSessionInitBatch` so
the piggyback `session_init` fired alongside the first `tool_call` of a
session also carries harness fields. `instrumentToolCall` spreads its event
into `recordToolCall`, so callers only need to pass `clientInfo` once at the
top level.

Integrators (such as `armature-tech/mcp-tester`) that lift `clientInfo`
off the MCP `initialize` handshake and pass it through can stop shipping
`null` harness columns. Existing callers that don't supply `clientInfo` see
no behavior change beyond the `client_name` fallback now being trimmed.
