# Changelog

## 0.3.0

### One credential instead of two — drop `mcpServerId`

The SDK now ships exactly one credential to Armature: the API key. Server identity
is derived server-side from the key, so `mcpServerId` / `ANALYTICS_MCP_SERVER_ID` is
removed end-to-end:

- `armature.mcpServerId` config field — removed
- `ANALYTICS_MCP_SERVER_ID` env var — no longer read
- `X-Armature-MCP-Server-Id` HTTP header — no longer sent
- `mcp_server_id` field on ingest events — no longer emitted

Customers register an MCP server in the Armature dashboard, name it there, and copy
its API key into `ANALYTICS_INGEST_API_KEY`. No second value to keep in sync.

### Switch from HMAC signing to bearer-token auth

The SDK now POSTs each batch with `Authorization: Bearer <apiKey>` instead of
computing an HMAC-SHA256 signature over `timestamp.body`. Equivalent security
posture for low-sensitivity telemetry, much simpler implementation on both ends,
and it aligns with the bearer-Scrypt scheme `mcp-tester` already uses — one auth
style for the whole Armature surface.

- `X-Armature-Timestamp` and `X-Armature-Signature` headers — no longer sent
- `signIngestBody` export — removed from the public API
- `Authorization: Bearer <apiKey>` header — added

### Rename `ingestSecret` → `apiKey`

To match the product nomenclature ("API key", not "ingest secret") and align with
how `mcp-tester` already names this credential:

| Before | After |
| --- | --- |
| `armature.ingestSecret` config | `armature.apiKey` |
| `ANALYTICS_INGEST_SECRET` env | `ANALYTICS_INGEST_API_KEY` |

The `ANALYTICS_INGEST_URL` env var is unchanged.

### Actor and event IDs are no longer salted with the server id

`buildActorId` is now `sha256(actorSeed)`. `buildEventId` drops the server-id prefix
too. This gives customers cross-server actor identity by default: the same
`actorSeed` (e.g. an internal user id) under two different MCP server registrations
in the same Armature org hashes to the same `actor_id`, so users carry across
surfaces in analytics. Customers who want per-server isolation can prefix the seed
themselves inside `armature.actorId`.

### Breaking changes — migration

1. Replace `ANALYTICS_INGEST_SECRET` with `ANALYTICS_INGEST_API_KEY` in your environment.
2. Delete `ANALYTICS_MCP_SERVER_ID` from your environment.
3. If you pass credentials in code, rename `armature.ingestSecret` → `armature.apiKey`
   and drop `armature.mcpServerId`.
4. The `mcp_server_id` field on `AnalyticsIngestEvent` is gone — anyone consuming the
   ingest format outside of Armature's own pipeline should remove their reads of it.
5. If you imported `signIngestBody` directly (e.g. to verify batches in a custom
   reverse-proxy), it's been removed — bearer auth replaces the HMAC scheme.

### Server-side requirement

This release requires the Armature ingest endpoint to resolve `mcp_server_id` from
the API key. Do not upgrade before the backend rollout is complete, or batches will
be rejected.

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
