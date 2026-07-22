# Changelog

## Unreleased

### Doctor no longer fails healthy servers that serve request_capability

The tool-wrapping check counted the SDK-owned `request_capability` tool —
which intentionally carries no telemetry block — as an unwrapped customer
tool, so a correct install with `requestCapability: true` exited 1 with
"needs attention". The coverage inspection now exempts the tool when both its
reserved name and exact advertised description match; a customer tool that
merely shadows the name is still held to the wrapping contract.

### Default-on secret redaction and queued privacy pipeline

- Added bounded sanitization and 13 high-confidence secret rules across tool
  inputs, outputs, errors, and telemetry text. Secret matching is enabled by
  default and can be disabled independently from binary sanitization.
- Added async whole-event `redactEvent` hooks with mutate, drop, and fail-closed
  semantics while preserving the legacy synchronous `redact` hook.
- Moved privacy finalization and delivery into a bounded FIFO queue with batch
  delivery, full-pipeline flushing, await mode, and serverless scheduling.
- Added cross-SDK contract vectors and before/after lifecycle benchmarks.

### Local installation doctor

- Added `npx @armature-tech/mcp-analytics doctor` for local, customer-run
  installation checks. It supports Streamable HTTP and stdio MCP servers,
  verifies initialize/tools-list behavior and per-tool Armature wrapping, and
  can validate the configured ingest key with an empty content-free batch.
- The command prints actionable local diagnostics and supports `--json`; it
  does not add a dashboard surface or a background diagnostics channel.

### Rich actor identification

`armature.actorIdentifier` now supplies one caller-provided string for both the
hashed `actor_id` and the verbatim identity value. The SDK emits a content-
addressed `actor_identity` event only when the identifier changes. Existing
`actorId` configuration remains a hashed-only fallback.

### Sparse user-turn telemetry

- Removed `user_turn` from advertised schemas and newly emitted events. Cached
  clients may still send it; the SDK strips and ignores it.
- `agent_thinking` is now requested on every call, while `user_intent` and
  `user_frustration` are requested only on the first call after each new user
  message. Repeating the same intent after a new message is meaningful.
- The former internal strict-intent config is deprecated and ignored because
  requiring intent on every call conflicts with sparse declarations.

### Opt-in capability request tool

- **`armature.requestCapability` (default `false`).** When enabled with a configured delivery path, the SDK dynamically injects a reserved `request_capability` tool across the recorder, `McpServer`, factory-wrapper, caller-owned registry, and Mastra integration paths. Agents call it with one required `capability` string when the available tools cannot complete the user's request. The call is acknowledged and emitted as a provenance-marked normal tool-call event; ingest routes it into the existing unmet-demand clustering pipeline. Global analytics disablement suppresses the tool, and name collisions fail explicitly.

### Telemetry capture switch, field ownership, and preview redaction

Three privacy/compliance features, shared with the Python and Go SDKs via a new cross-SDK contract (`packages/TELEMETRY-CONTRACT.md` in the monorepo, with shared test vectors in all three packages):

- **`armature.captureTelemetry` (default `true`).** When `false`, the SDK injects no `telemetry` schema field, appends no description nudges (tool descriptions and server instructions pass through byte-identical), and never exports conversation-derived telemetry — including values sent by clients holding a cached schema, which are stripped from handler args and dropped at a single choke point in `recordToolCall` before they can reach ingest, `emit`, or `onError`. Motivated by app-store review requirements (e.g. OpenAI Apps SDK submission guidelines) that treat conversation-derived data as behavioral profiling requiring disclosure and user control.

- **Per-tool telemetry field ownership.** A tool whose input schema already declares a top-level `telemetry` property is now treated as owning that field on every integration surface (recorder registry, caller-owned `McpServer` registration, the prototype patch, Mastra, custom dispatchers): the schema and description are no longer overwritten, arguments reach the handler untouched, and the customer's values — including the `intent`/`context` legacy-alias spellings — are never interpreted as Armature telemetry. A warning is logged once per tool at registration. **Behavior change:** previously the TS SDK overwrote a colliding `telemetry` schema and stripped the customer's object at runtime. Customers who relied on that (unlikely, since their own field was being swallowed) can export equivalent fields explicitly via the new `armature.telemetryFieldMap` option, which reads (never strips) mapped top-level argument properties into telemetry fields.

- **Built-in preview sanitization plus an `armature.redact` hook.** Before previews are serialized, image/audio content-block `data`, resource `blob`s, base64 data URIs, and long base64-only strings are replaced with contract placeholders (`[binary removed]`, `[base64 removed]`). A customer-supplied `redact` hook then runs over the sanitized inputs, outputs, error strings, and telemetry text (pipeline: sanitize → redact → stringify → truncate, covering `input_preview`, `script_source`, `result_preview`, and `error`). A throwing hook fails closed to `[redaction failed]` instead of shipping unredacted data; the event itself still ships.

## 0.7.1

### Zod 4 raw-shape input schemas no longer crash server startup

Apps that register tools with a Zod 4 raw shape (`inputSchema: { name: z.string() }` with `zod@4` — the default for SkyBridge/Alpic servers and the style the MCP SDK docs use) crashed at `registerTool` time with `Mixed Zod versions detected in object shape`: the raw-shape decoration branch always injected the Zod 3 build of the telemetry field, and recent MCP SDKs refuse shapes that mix Zod majors. Whole `ZodObject` input schemas were already version-sniffed; raw shapes now get the same treatment — the shape's values are checked for the Zod 4 `_zod` brand and the telemetry field is built with the matching major (both builds already shipped in the package via `zod` + `zod/v4`, so this adds no dependency).

Notes: an empty raw shape has nothing to sniff and keeps the Zod 3 telemetry field, which every SDK accepts in a single-version shape. Zod 4 raw shapes also require an MCP SDK new enough to support them (the 1.20 peer floor silently drops v4 raw-shape fields; verified end-to-end against SDK 1.29 + skybridge 1.2.7 + zod 4.4.3, including a SkyBridge server round trip with telemetry capture).

## 0.7.0

### V1 telemetry schema: user_turn / user_intent / agent_thinking / user_frustration

The injected `telemetry` parameter moves to the V1 field names: `user_intent` (was `intent`), `agent_thinking` (was `context`), `user_frustration` (was `frustration_level`), plus the new `user_turn` — a 1-based count of user messages the agent repeats on every call, which gives the session view a reliable new-message signal instead of inferring turns from wording changes. Field descriptions are rewritten per the V1 wording spec, and the analytics rationale is no longer shown to the agent. The TypeScript and Python SDKs carry byte-identical description strings so agents see the same tool statements in both languages.

Backward compatibility, both directions:

- **Old agents / cached schemas → this SDK:** the telemetry object accepts unknown keys (Zod paths use passthrough/loose objects) and `normalizeTelemetryArgs` maps the pre-V1 spellings onto the V1 names, so a client that cached a pre-V1 tool schema keeps recording. Callers passing `telemetry` directly into `recordToolCall` may likewise still use the old keys, and `telemetry: { intent: "required" }` strict config still works alongside the new `user_intent` key.
- **This SDK → old ingest:** tool-call event metadata carries the V1 keys plus legacy mirrors (`intent`, `context`, `frustration_level` copied from their V1 counterparts), so an Armature deployment that predates the V1 schema keeps reading events unchanged.

`report_blocker` (the standalone blocker tool that replaces the old per-call `blockers` idea) is parked for V1 per the spec and is not part of this release.

## 0.6.8

### Give stdio sessions a real session id (fixes distinct CLI conversations merging into one activity)

stdio MCP servers — the transport `claude -p` and other CLI clients use — never see a session id: `StdioServerTransport.sessionId` stays undefined and there is no HTTP request, so every event shipped with `session_id_hint: null` and no `session_init` was ever emitted. Armature's ingest groups null-hint events into a coarse per-actor **daily** bucket, so two distinct same-day CLI conversations from the same user were merged into a single activity.

A stdio server process is spawned by its client and serves exactly one connection for its whole lifetime, so process identity is session identity. The recorder now falls back to a lazily minted **process-scoped session id** (`stdio-<uuid>`) whenever a request carries no session signal and no HTTP headers at all. Consequences: stdio events carry a stable, per-conversation `session_id_hint`; a `session_init` is emitted once per stdio session; and the initialize-handshake `clientInfo` is cached under the same id, so the dashboard's Client column resolves for CLI sessions (e.g. `claude-code`).

Requests that DO carry HTTP headers are deliberately excluded from the fallback — many sessions share one long-lived HTTP server process, so their missing session id stays `null` and ingest keeps bucketing them server-side. As a smaller addition, an `Mcp-Session-Id` header passed via the event-level `headers` field (not just `extra.requestInfo.headers`) now also resolves as the session id. The fallback id's `stdio-` prefix intentionally does not match the stateless-HTTP `mcp_<name>_v_<version>_<uuid>` shape, so it can never be misparsed as an identity-bearing id.

The same fix ships in the Python SDK (`armature-mcp-analytics`), where the FastMCP adapter additionally pulls request headers from `fastmcp.server.dependencies.get_http_headers(include={"mcp-session-id"})` — the `include` opt-in matters because fastmcp strips `Mcp-Session-Id` by default. HTTP FastMCP deployments are thereby both excluded from the stdio fallback AND get real per-session ids for the first time (previously all their events shipped null hints).

Known limit: a resumed CLI conversation (`claude -p --resume`) spawns a new process and therefore starts a new analytics session — stdio offers no durable cross-process session identity.

## 0.6.7

### Record tool calls that return `isError: true` as failures

Per MCP convention, a server signals a recoverable/upstream failure by returning a normal `CallToolResult` with `isError: true` (so the agent can see and retry it) rather than throwing. The recorder previously marked a tool call `ok: true` whenever the handler resolved without throwing — it never inspected the returned result — so every such failure was recorded as a success with `error: null`. Concretely, `notion-mcp` returns upstream Notion 4xx/5xx as `{ content: [{ type: "text", text: "Notion error (…)" }], isError: true }`; analytics recorded those as `ok=true`, leaving raw `error_count` blank and the session judge's `upstream_api_failure_count` at 0.

Both instrumentation paths — `instrumentToolCall` (registry / `recorder.tool` / `attachToMcpServer`) and the `withMcpAnalytics` prototype-patch callback — now inspect the resolved result via a shared `deriveToolResultError` helper. When the result is an MCP error result (`isError === true`), the call is recorded with `status: "error"` and a human-readable message derived from the first text content item (falling back to a generic `"tool returned isError"` when no text is present). The original result is still returned to the caller **unchanged** — this only affects what telemetry records, never what the agent receives. A thrown handler still records an error exactly as before. The check is defensive about shape: a non-object, plain value, or missing `content` is treated as a success and never throws.

No public API or type change. Added unit tests covering: a returned `isError` result records `ok=false` with the error text while the caller still gets the original result; a normal success still records `ok=true`; an `isError` result with no text falls back to a generic message; a throwing handler still records `ok=false`; and the same end-to-end through `withMcpAnalytics`.

## 0.6.5

### Stamp `is_workflow` on telemetry produced by Armature workflow runs

When an Armature workflow run drives a wrapped MCP server, the run dispatcher adds an `X-Armature-Workflow-Run-Id: <run uuid>` header to the MCP connection. The recorder now detects that header on incoming requests (`extra.requestInfo.headers`, any casing; non-uuid values are ignored) and stamps every resulting event — `tool_call` and its paired `session_init` — with top-level `is_workflow: true` and `workflow_run_id`. Armature's ingest uses the markers to keep synthetic harness traffic out of Session Analytics: flagged sessions are neither shown nor processed.

Hosts that resolve the run id themselves can pass `workflowRunId` explicitly on `recordToolCall` / `recordSessionInit` / `instrumentToolCall` / tool-handler contexts; the explicit value wins over the header. No behavior change for organic traffic: the fields are absent (not `false`) when no marker is present.

## 0.6.4

### Bound the per-recorder `session_init` dedup set; make `session_init` event ids stable per session

Each recorder kept a `sessionInitKeys` set of `${actorId}:${sessionId}` pairs so it emits at most one `session_init` per session. That set was **never evicted** — the exact unbounded-growth problem its sibling, the client-info cache, was written to avoid (MCP fires no reliable "session-closed" signal). On a long-running server with high session churn — many distinct `Mcp-Session-Id`s, e.g. the multi-client / stateless-gateway shape from #37 — it leaked memory indefinitely.

The set is now bounded at 10k entries with FIFO eviction, mirroring the client-info cache (a shared `createBoundedKeySet` helper). Eviction is made safe by a second change: `session_init`'s `event_id` is now derived **stably from `(actorId, sessionId)`** instead of from the triggering tool call's (random) `event_id`. A session has exactly one `session_init`, so this is the correct key — and it means a `session_init` re-emitted after eviction (or after a process restart / serverless cold start that re-handles the same session) collapses to the same id at ingest rather than double-counting. `kind` is already part of the event-id hash, so there is no collision with `tool_call` ids.

No public API change. The 0.6.2 tool-call collision guarantee and the #37 stateless client-name fix are both unaffected. Added regression tests: `createBoundedKeySet` FIFO eviction, `session_init` id stability per `(actorId, sessionId)`, and that a fresh recorder re-emits the same `session_init` id for the same session.

## 0.6.3

### Capture `initialize` clientInfo by the `Mcp-Session-Id` header for stateless Streamable HTTP

For stateless / serverless Streamable HTTP deployments (e.g. Vercel) the dashboard still showed `Client: Unknown` when the client's identity was only present in `initialize.params.clientInfo`. In stateless mode `sessionIdGenerator` is disabled, so `transport.sessionId` is undefined; the client instead carries its session via the `Mcp-Session-Id` request header. The client-info cache only keyed `clientInfo` by `transport.sessionId ?? params._meta?.sessionId`, so the initialize payload was never cached under the header session id — and the later `tools/call`, normalized to that header, found nothing, leaving `metadata.client_name` null.

The capture patch now wraps `Server.prototype._onrequest` (the request dispatcher) instead of `Server.prototype._oninitialize`. The SDK registers the initialize handler as `request => this._oninitialize(request)`, dropping the per-request `extra`, so `_oninitialize` never sees request headers; `_onrequest` receives both the `initialize` payload (with `clientInfo`) and `extra.requestInfo.headers` (with `Mcp-Session-Id`). The clientInfo is now cached under **every** observable session-id key — `transport.sessionId`, the `Mcp-Session-Id` header, and `params._meta.sessionId` — so the tool-call lookup hits regardless of which one that request resolves to. Header lookup is case-insensitive (via the shared `headerValue` helper) and capture remains best-effort: any failure is swallowed and never breaks the handshake.

Result: stateless HTTP with `Mcp-Session-Id` + initialize `clientInfo.name` now renders the real client name, with no need for the non-standard `x-mcp-client` header. The 0.6.2 event-id collision guarantee is unaffected. Added regression tests simulating stateless Streamable HTTP (header-only session identity) and the dual-key (transport + header) case.

## 0.6.2

### Fix `event_id` collisions seeded from the MCP JSON-RPC request id

`event_id` for a tool call was derived as `sha256(actorId + " tool_call " + requestId)`, and in two of the three instrumentation paths `requestId` fell back to the MCP JSON-RPC request id (`extra.requestId`):

- `instrumentMcpServerTools` / `attachToMcpServer` / `recorder.tool` — the registered callback set no request id, so `normalizeRequestId` used `String(extra.requestId)`.
- the Mastra adapter (`wrapMastraTools`) — it explicitly forwarded `String(extra.requestId)`.

The JSON-RPC request id is an in-memory per-client counter (`0, 1, 2, …`) that restarts whenever a client reconnects, restarts, or a stateless gateway/client instance is recreated. Two unrelated tool calls that resolve to the same actor (commonly `"anonymous"` or a shared auth/client id) and the same counter value therefore produced an identical `event_id`. Ingest dedupes by `event_id`, so the second call was dropped — undercounting events, and in some cases preventing a second session from being counted when the duplicate short-circuited before session persistence. (Confirmable in Datadog via `@event:mcp_analytics_ingest @duplicate_count:>0`.)

`normalizeRequestId` no longer derives the analytics request id from `extra.requestId`. An explicit caller-supplied id still wins (a deliberate idempotency key); otherwise a fresh per-call uuid is minted — matching what the `withMcpAnalytics` / `createMcpAnalyticsServer` prototype-patch path already did. The Mastra adapter stops forwarding `extra.requestId` for this purpose; the JSON-RPC id remains available in `extra` for everything else. `event_id` is still computed once at event-build time, so HTTP-delivery retries of the same batch dedupe correctly.

The handler context built for registered tools (`buildHandlerContext`) also no longer surfaces `extra.requestId` as `context.requestId`: `dispatch` spreads that context into `instrumentToolCall`, so a handler that fanned out to a nested tool while forwarding its context would otherwise re-seed the nested call's `event_id` with the JSON-RPC id. The MCP request id stays reachable via `context.extra.requestId`.

Regression tests assert that two tool calls sharing the same `extra.requestId` (same actor/session) emit distinct `event_id`s — through the recorder funnel, the Mastra adapter, and nested tool calls that forward the handler context.

## 0.6.1

### Mastra adapter: drop the index signature from `MastraTool` so real `Tool<...>` class instances assign without a cast

`@mastra/core/tools` returns a `Tool<...>` *class instance* with a `#private` brand. The previous `MastraTool` definition included `[key: string]: unknown`, and TypeScript refuses to assign a class with a `#private` field to a structural type carrying an index signature — the brand isn't representable. Every Mastra integrator hit this and had to write:

```ts
tools: wrapMastraTools(
  createRawExampleOperationTools() as unknown as MastraToolMap,
  { armature: { delivery: "await" } },
) as unknown as ExampleOperationTools,
```

The integrator-side cast is now gone. `MastraTool` is a closed object type (no index signature) listing only the optional fields the adapter actually reads (`id`, `description`, `inputSchema`, `outputSchema`, `annotations`, `execute`). Mastra's `Tool<...>` class instance satisfies the constraint structurally, and the existing `<T extends MastraToolMap>(tools: T) => T` generic preserves the caller's narrow type end-to-end so the result drops straight into `new MCPServer({ tools })`. host-style call sites compile as:

```ts
tools: wrapMastraTools(createRawExampleOperationTools(), {
  armature: { delivery: "await" },
})
```

Added a `#brand`-bearing class fixture to the test suite — if a future refactor reintroduces the index signature or otherwise breaks class-instance assignment, `tsc --noEmit -p tsconfig.test.json` fails.

Runtime behavior is unchanged: schema decoration, telemetry stripping, default `context.mcp.extra` extraction, and `resolveExtra` layering all work exactly as in 0.6.0.

## 0.6.0

Drops the integration boilerplate every Mastra adopter (e.g. Example MCP) had been writing around `wrapMastraTools`, adds a `instrumentMcpServerTools` helper for servers that can't use `createMcpAnalyticsServer`'s prototype-patching path, and broadens the default actor-seed resolution to cover two more common auth field names.

### Mastra adapter: auto-extract standard MCP context

`wrapMastraTools` and `wrapMastraToolsWithRecorder` now pull `sessionId`, `requestId`, `requestInfo.headers`, and `authInfo` straight out of Mastra's standard MCP context — `context.mcp.extra` (with `context.requestContext.get("mcp.extra")` as a fallback). Adopters no longer need an app-specific `resolveExtra` callback just to forward the fields Mastra already provides. The exported `defaultMastraResolveExtra` is the same function the adapter runs internally, available for callers that want to reuse it. An existing `resolveExtra` callback still works as an override / extension point — its return value is merged on top of the default extraction, per field (`authInfo.token` from the default and `authInfo.apiKey` from the callback are kept together; one doesn't wholesale-clobber the other). The `authInfo` cast at the extraction boundary is narrowed to only the four fields the SDK actually consumes (`token`, `clientId`, `apiKey`, `principalId`), so host-attached PII or internal IDs don't silently propagate through the analytics pipeline.

### Actor-seed aliases: `apiKey`, `principalId`

`resolveActorSeed` now also recognises `authInfo.apiKey` and `authInfo.principalId` as actor-seed inputs (alongside the existing `token` and `clientId`). Hosts whose auth shim exposes credentials under those names — Example MCP is one — no longer need a custom `actorId` resolver just to map between the two. `RequestExtra.authInfo` gained the two optional fields to match.

### Mastra adapter: generic over the input tool-map type

`wrapMastraTools`, `wrapMastraToolsWithRecorder`, and `MastraAnalytics.wrapTools` are now `<T extends MastraToolMap>(tools: T) => T`. An host-style `Record<string, MastraCreatedTool<...>>` round-trips through them without needing `as unknown as MastraToolMap` casts at the call site or on the return — the customer's narrow tool-map type is preserved end-to-end so the result drops straight into `new MCPServer({ tools })`.

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

Hosts using zod/v4 (e.g. the example service's `packages/mcp`) declare tool inputs as
`zv4.object({ request: schema }).strict()`. The Mastra adapter detected these as v3
`ZodObject`s (both have `.shape` and `.extend`) and extended them with a v3 telemetry
block. `.extend()` accepted the cross-version shape silently, then every `.parse()` threw
`Invalid element at key "telemetry": expected a Zod schema`, breaking every tool call at
the Mastra/MCP input-validation boundary.

The adapter now discriminates v4 from v3 via the `_zod` brand v4 schemas carry, and
builds the telemetry block from the matching namespace.

### README rewrite

Restructured to lead with the value proposition and a single drop-in example, modeled on
[example-org/example-mcp](https://github.com/example-org/example-mcp)'s README. The four parallel
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
