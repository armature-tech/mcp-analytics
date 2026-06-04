# Changelog

## 0.6.0

Drops the integration boilerplate every Mastra adopter (e.g. Autumn) had been writing around `wrapMastraTools`, adds a `instrumentMcpServerTools` helper for servers that can't use `createMcpAnalyticsServer`'s prototype-patching path, and broadens the default actor-seed resolution to cover two more common auth field names.

### Mastra adapter: auto-extract standard MCP context

`wrapMastraTools` and `wrapMastraToolsWithRecorder` now pull `sessionId`, `requestId`, `requestInfo.headers`, and `authInfo` straight out of Mastra's standard MCP context — `context.mcp.extra` (with `context.requestContext.get("mcp.extra")` as a fallback). Adopters no longer need an app-specific `resolveExtra` callback just to forward the fields Mastra already provides. The exported `defaultMastraResolveExtra` is the same function the adapter runs internally, available for callers that want to reuse it. An existing `resolveExtra` callback still works as an override / extension point — its return value is merged on top of the default extraction, per field (`authInfo.token` from the default and `authInfo.apiKey` from the callback are kept together; one doesn't wholesale-clobber the other). The `authInfo` cast at the extraction boundary is narrowed to only the four fields the SDK actually consumes (`token`, `clientId`, `apiKey`, `principalId`), so host-attached PII or internal IDs don't silently propagate through the analytics pipeline.

### Actor-seed aliases: `apiKey`, `principalId`

`resolveActorSeed` now also recognises `authInfo.apiKey` and `authInfo.principalId` as actor-seed inputs (alongside the existing `token` and `clientId`). Hosts whose auth shim exposes credentials under those names — Autumn is one — no longer need a custom `actorId` resolver just to map between the two. `RequestExtra.authInfo` gained the two optional fields to match.

### Mastra adapter: generic over the input tool-map type

`wrapMastraTools`, `wrapMastraToolsWithRecorder`, and `MastraAnalytics.wrapTools` are now `<T extends MastraToolMap>(tools: T) => T`. An Autumn-style `Record<string, MastraCreatedTool<...>>` round-trips through them without needing `as unknown as MastraToolMap` casts at the call site or on the return — the customer's narrow tool-map type is preserved end-to-end so the result drops straight into `new MCPServer({ tools })`.

### New entry point: `instrumentMcpServerTools`

For servers that already own both an `McpServer` instance and a tool registry (array or map), the new `instrumentMcpServerTools({ server, tools, config, mapTool })` helper decorates each tool's input schema with the telemetry block, strips telemetry before invoking the original handler, and emits analytics batches — by calling `server.registerTool(...)` directly on the caller-passed instance. No `McpServer.prototype` patching for the tool-registration path, so it survives pnpm virtual-peer layouts where `createMcpAnalyticsServer`'s patch can land on a different `@modelcontextprotocol/sdk` module copy than the customer's, and it removes the factory-function refactor `createMcpAnalyticsServer` requires. Two-overload surface makes `mapTool` required whenever the registry shape doesn't structurally satisfy `InstrumentedTool`, so custom registries can't compile cleanly without a mapper and then throw "handler is not a function" at runtime.

## 0.5.0

Surfaced and fixed three regressions that prevented `createMcpAnalyticsServer(...)` from instrumenting servers that use the deprecated `server.tool(...)` overload, plus an API cleanup so customers cannot reach into telemetry behavior.

### Instrument the deprecated `server.tool(...)` overload

Older codebases and hand-rolled servers call `server.tool(name, paramsSchema, cb)` instead of the newer `registerTool(...)`. The previous prototype patch only wrapped `registerTool`, so the SDK silently appeared installed but never decorated those tools or recorded their calls. The patch now also rewrites `McpServer.prototype.tool`: every overload is parsed, normalised into a config object, and routed through the same decoration + recording path as `registerTool`. A new end-to-end test in `tests/with-mcp-analytics.test.ts` covers this shape via a real MCP transport.

### Telemetry block is genuinely optional on Zod schemas

The Zod path extended the parent object with a non-`.optional()` telemetry schema, so even though the inner fields were optional the `telemetry` key itself was required — every call that omitted the block failed parse at the MCP input boundary. `createTelemetryInputSchema` (v3 and v4) now wraps the loose schema with `.optional()` so customers can omit it entirely. Matches the existing JSON-schema-side behavior. Strict mode (`intent: "required"`) is unchanged.

### `@modelcontextprotocol/sdk` is now a peer dependency

Under pnpm the SDK previously kept its own nested copy of `@modelcontextprotocol/sdk`, so patching `McpServer.prototype` patched the wrong class — the customer's `McpServer` instances were untouched. Moved the SDK from `dependencies` to `peerDependencies` (with a matching `devDependencies` entry for local builds and tests). Customers must already have `@modelcontextprotocol/sdk` installed (the install instructions in the README already say so), so this is not a new requirement — but it guarantees the patch lands on the same class the customer constructs.

### Hide `telemetry` from `McpAnalyticsConfig`

Telemetry schema shape is Armature-owned. Removed the `telemetry` field from the public `McpAnalyticsConfig` type and from the default config; customers only set operational config (`armature.delivery`, `actorId`, `timeoutMs`, etc.). The strict-mode flag survives internally on a non-exported `InternalMcpAnalyticsConfig` so the SDK can still opt into validation; lower-level schema utilities (`decorateInputSchemaWithTelemetry`, `createTelemetryInputSchema`, `createTelemetryJsonSchema`) still accept it.

### Breaking changes

- `McpAnalyticsConfig.telemetry` is gone from the public type. Any consumer that was passing `telemetry: { intent: "required" }` to `createMcpAnalyticsServer`, `withMcpAnalytics`, `createAnalyticsRecorder`, `wrapMastraTools`, or `createMastraAnalytics` should drop that field.
- `@modelcontextprotocol/sdk` moved to `peerDependencies`. Installs that did not already list the SDK explicitly will need to add it.

## 0.4.3

### Mastra adapter: decorate zod/v4 inputSchemas with a v4 telemetry block

Hosts using zod/v4 (e.g. Autumn's `packages/mcp`) declare tool inputs as
`zv4.object({ request: schema }).strict()`. The Mastra adapter detected these as v3
`ZodObject`s (both have `.shape` and `.extend`) and extended them with a v3 telemetry
block. `.extend()` accepted the cross-version shape silently, then every `.parse()` threw
`Invalid element at key "telemetry": expected a Zod schema`, breaking every tool call at
the Mastra/MCP input-validation boundary.

The adapter now discriminates v4 from v3 via the `_zod` brand v4 schemas carry, and
builds the telemetry block from the matching namespace.

### README rewrite

Restructured to lead with the value proposition and a single drop-in example, modeled on
[useautumn/autumn](https://github.com/useautumn/autumn)'s README. The four parallel
quick-starts collapsed into one primary shape (`createMcpAnalyticsServer`) plus a short
pointer to [`SKILL.md`](SKILL.md) for the registry / dispatcher / Mastra alternatives.
No API changes.

## 0.4.2

### Default telemetry schema no longer enforces value constraints

The decorated `telemetry` block was advertised as optional but still rejected calls when
clients sent off-spec values: `intent: ""` (failed `min(1)`) or
`frustration_level: "annoyed"` (failed the enum). That's enforcement leaking into the
customer's tool surface — a misclassified frustration value from an LLM agent could fail
the tool call.

Default schema is now fully permissive: `intent`/`context`/`frustration_level` are all
optional plain strings with no `minLength` or enum constraints (descriptions still hint at
valid values for the agent). Opt back into strict validation with
`telemetry: { intent: "required" }` — that mode still requires a non-empty `intent` and
constrains `frustration_level` to the `low | medium | high` enum, same as before.

### `MastraToolExecute` widened from `unknown` to `any` to eliminate adapter casts

Mastra's `createTool({...}).execute` is typed
`(inputData: TInput, context: ToolExecutionContext<TInput>) => Promise<TOutput>`.
Function parameters are contravariant, so a function whose `inputData` / `context`
params are narrower is not assignable to one whose params are `unknown` — customers
had to cast their tool map into `wrapMastraTools` and cast the return back out just
to satisfy `tsc`. Both params are now `any`, so narrower-typed tools assign in (and
out) cleanly. The SDK still imports nothing from `@mastra/*` at runtime — this is a
structural-typing fix, not a dependency change.

### Default `endpointUrl` is now the prod ingest, not localhost

`defaultMcpAnalyticsConfig.armature.endpointUrl` and the `resolveEndpointUrl` fallback
now return `https://app.armature.tech/api/mcp-analytics/ingest` instead of
`http://127.0.0.1:8787/api/mcp-analytics/ingest`. Customers who installed the SDK in a
serverless prod environment without setting `ANALYTICS_INGEST_URL` were silently POSTing
to localhost (nothing listening) and watching `onError` swallow the failure. With the
prod default, the SDK works out-of-the-box in production and only requires
`ANALYTICS_INGEST_URL` when pointing at a local mock or staging environment.

Local development against `npm run dev:armature` still works —
`instrumented-demo-client.ts` already sets `endpointUrl` explicitly, and any other local
mock setup needs to set `ANALYTICS_INGEST_URL=http://127.0.0.1:8787/api/mcp-analytics/ingest`
going forward.

## 0.4.0

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
