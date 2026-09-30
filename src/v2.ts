import {
  BAGGAGE_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import type {
  HeaderBag,
  McpAnalyticsConfig,
  McpClientInfo,
  RequestExtra,
  TelemetryMode,
} from "./types.js";
import {
  createAnalyticsRecorderCore,
  type AnalyticsRecorderCore,
} from "./recorder-core.js";
import { defaultMcpAnalyticsConfig } from "./emit.js";
import {
  appendTelemetryHint,
  createTelemetryJsonSchema,
  isCaptureEnabled,
  schemaDeclaresTelemetry,
} from "./schema.js";
import { capCapabilities } from "./events.js";
import { prepareForPreview } from "./sanitize.js";
import { headerValue, isRecord, stringifyPreview, truncateUtf8 } from "./utils.js";
import { processScopedSessionId } from "./stdio-session.js";
import {
  clientInfoFromInitializeBody,
  resolveStatelessHttpSession,
} from "./stateless-http.js";

// Adapter for the v2 MCP TypeScript SDK (@modelcontextprotocol/server 2.x,
// protocol revision 2026-07-28). The v2 protocol is stateless: there is no
// initialize handshake and no Mcp-Session-Id — client identity travels
// per-request in the reserved `_meta` envelope, and session identity has to be
// derived per request (see the ladder in `resolveV2SessionId`). This module
// therefore never loads the v1 `@modelcontextprotocol/sdk` package: both peers
// are optional, and a v2-only install imports `@armature-tech/mcp-analytics/v2`
// exclusively (the package root still requires the v1 SDK at runtime).

/** Header a caller can set to pin the analytics session id (rung 2 of the ladder). */
export const SESSION_SEED_HEADER = "x-armature-session-seed";

const REQUEST_META_MAX_BYTES = 4 * 1024;

// Wrapped callbacks are tagged so re-instrumenting a server (or re-running
// `withMcpAnalytics` over a factory-produced instance) can never double-wrap
// and double-record a tool.
const WRAPPED_CALLBACK = Symbol.for("armature.mcpAnalytics.v2.wrappedCallback");

// ─── Minimal structural types ───────────────────────────────────────────────
// Structural on purpose: the adapter must not put `@modelcontextprotocol/server`
// types into its public signatures (so the emitted d.ts stays loadable when
// only one of the optional peers is installed), and the real `McpServer` is
// assignable to these shapes.

/** Structural stand-in for a v2 `McpServer`: anything with `registerTool`. */
export type V2McpServerLike = {
  registerTool: (name: string, config: never, cb: never) => unknown;
};

// Internal shape of a v2 `RegisteredTool` (all public members on the real
// type). `update({ callback })` regenerates the SDK's internal executor, which
// keeps the schema-keyed callback arity — (args, ctx) with an inputSchema,
// (ctx) without — exactly as the SDK dispatches it. `update({ paramsSchema })`
// swaps the stored input schema AND invalidates the SDK's memoized JSON
// conversion, so `tools/list` and the pre-dispatch validation both see the
// replacement (the declareTelemetry decoration path relies on this).
type V2RegisteredToolInternal = {
  description?: string;
  inputSchema?: unknown;
  handler?: (...args: unknown[]) => unknown;
  update?: (updates: {
    callback: (...args: unknown[]) => unknown;
    paramsSchema?: unknown;
    description?: string;
  }) => void;
};

type V2McpServerInternals = {
  registerTool?: (...args: unknown[]) => unknown;
  _registeredTools?: Record<string, unknown>;
  /** @internal SDK helper: the JSON Schema `tools/list` would advertise. */
  toolInputSchemaJson?: (name: string) => unknown;
};

// Per-request fallbacks captured from the `McpRequestContext` handed to a
// `createMcpHandler`/`serveStdio` factory. `ctx.http.req` exists only on
// McpServer handler contexts — the low-level `Server` sets `http.authInfo`
// without `req` — so header-based rungs (session seed, workflow id) fall back
// to the factory context's `requestInfo` when the handler ctx has no request.
type V2RequestDefaults = {
  headers?: HeaderBag;
  authInfo?: RequestExtra["authInfo"];
  hasHttpRequest: boolean;
};

type V2RecorderState = {
  core: AnalyticsRecorderCore;
  config: McpAnalyticsConfig;
  toolModes: Map<string, TelemetryMode>;
};

/**
 * v2-adapter behavior options, passed alongside the analytics config to
 * `withMcpAnalytics` / `instrumentedFactory`. Kept separate from
 * `McpAnalyticsConfig` because the recorder (delivery queue, session_init
 * dedupe) is keyed on the config object; these options only shape how tools
 * are wrapped and what metadata each event carries.
 */
export type V2AdapterOptions = {
  /**
   * Advertise the Armature `telemetry` input property on every instrumented
   * tool's schema (v1 parity, opt-in). The adapter rebuilds each tool's
   * ADVERTISED schema from the SDK's own JSON conversion
   * (`toolInputSchemaJson`) plus the telemetry property (byte-identical
   * descriptions to the v1 integration) via `fromJsonSchema`, and swaps it in
   * with `RegisteredTool.update({ paramsSchema })` — so `tools/list`
   * advertises telemetry AND the SDK's pre-dispatch Ajv validation accepts it
   * before the analytics wrapper strips it. A top-level
   * `additionalProperties: false` in the customer schema is preserved:
   * `telemetry` becomes a declared property (so it passes), while every other
   * undeclared key is still rejected exactly as before.
   *
   * Tradeoff: validation then runs against the JSON Schema projection of the
   * original schema. Zod runtime effects that don't survive JSON Schema
   * conversion (`.transform()`, `.refine()`, applied `.default()` values) no
   * longer run inside the SDK's validation step — which is why this is
   * opt-in. Tools whose schema cannot be projected to a JSON object schema
   * are left undecorated (telemetry is still stripped and exported when a
   * client sends it). Tools that declare their own `telemetry` property stay
   * customer-owned and untouched.
   */
  declareTelemetry?: boolean;
  /**
   * Per-event metadata hook: called once per tool call with the handler
   * context, and its returned keys are merged into the tool_call event's
   * metadata alongside the adapter's own keys (`protocol_era`, client
   * identity, `request_meta`, …). Hook keys win over adapter-derived keys;
   * contract-defined keys (`tool_name`, `user_intent`, …) always win over
   * both (see events.ts metadataExtra). A throwing hook is ignored — it never
   * breaks recording or the tool call.
   */
  metadata?: (ctx: unknown) => Record<string, unknown> | undefined;
};

// ─── Per-request capture ────────────────────────────────────────────────────

/**
 * Parse `gen_ai.conversation.id` out of a W3C `baggage` value: comma-separated
 * `key=value` list entries, each optionally carrying `;`-separated properties,
 * values URL-decoded. Rung 1 of the session-id ladder.
 */
export const conversationIdFromBaggage = (baggage: unknown): string | undefined => {
  if (typeof baggage !== "string") return undefined;
  for (const entry of baggage.split(",")) {
    const member = entry.split(";")[0]?.trim();
    if (!member) continue;
    const separator = member.indexOf("=");
    if (separator <= 0) continue;
    if (member.slice(0, separator).trim() !== "gen_ai.conversation.id") continue;
    const raw = member.slice(separator + 1).trim();
    if (!raw) continue;
    try {
      const decoded = decodeURIComponent(raw).trim();
      return decoded.length > 0 ? decoded : undefined;
    } catch {
      return raw;
    }
  }
  return undefined;
};

const trimOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// The reserved io.modelcontextprotocol/* keys are lifted out of params._meta
// into ctx.mcpReq.envelope before handlers run. The published 2.0.0 d.ts
// declares `type RequestMetaEnvelope = {}`, so envelope access needs the
// record cast below; the runtime object is keyed by the full reserved strings
// (the exported *_META_KEY constants).
const clientInfoFromEnvelope = (
  envelope: Record<string, unknown> | undefined,
): McpClientInfo | undefined => {
  if (!envelope) return undefined;
  const rawInfo = envelope[CLIENT_INFO_META_KEY];
  const info = isRecord(rawInfo) ? rawInfo : undefined;
  // clientInfo is OPTIONAL per the final 2026-07-28 spec (a SHOULD): the
  // required per-request pair is protocolVersion + clientCapabilities, so a
  // missing clientInfo is a legitimate steady state — never assume it.
  const name = trimOrUndefined(info?.name);
  const version = trimOrUndefined(info?.version);
  const protocolVersion = trimOrUndefined(envelope[PROTOCOL_VERSION_META_KEY]);
  const rawCapabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
  const capabilities = isRecord(rawCapabilities) ? rawCapabilities : undefined;
  if (
    name === undefined
    && version === undefined
    && protocolVersion === undefined
    && capabilities === undefined
  ) {
    return undefined;
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    capabilities: capabilities ?? null,
  };
};

// Request `_meta`, captured into tool_call metadata as `request_meta`, capped
// at 4KB. Note the reserved envelope keys are already lifted OUT of `_meta` by
// the SDK before handlers run, so this is typically the W3C trace slots
// (`traceparent`, `tracestate`, `baggage` keep their bare names and are NOT
// lifted) plus any custom keys the client sent. Custom keys are client-
// controlled free text, so the capture runs through the same
// preview-preparation pipeline as tool inputs/results — base64/binary
// sanitization plus built-in secret redaction (when enabled) — before the cap
// is applied; previously raw `_meta` under 4KB shipped verbatim.
const capRequestMeta = (
  meta: Record<string, unknown> | undefined,
  redactSecrets: boolean,
): Record<string, unknown> => {
  if (!meta || Object.keys(meta).length === 0) return {};
  const prepared = prepareForPreview(meta, undefined, { redactSecrets });
  const serialized = stringifyPreview(prepared);
  const { value, truncated } = truncateUtf8(serialized, REQUEST_META_MAX_BYTES);
  return truncated
    ? { request_meta: value, request_meta_truncated: true }
    : { request_meta: prepared };
};

type V2Capture = {
  sessionId?: string;
  clientInfo?: McpClientInfo;
  extra: RequestExtra;
  metadataExtra?: Record<string, unknown>;
};

// Never let an integrator-supplied metadata hook break a tool call (or its
// recording): a throw yields no extra keys, same as returning undefined.
const safeMetadataHook = (
  hook: V2AdapterOptions["metadata"],
  ctx: unknown,
): Record<string, unknown> | undefined => {
  if (typeof hook !== "function") return undefined;
  try {
    const extra = hook(ctx);
    return isRecord(extra) ? extra : undefined;
  } catch {
    return undefined;
  }
};

const captureV2Request = (
  ctxValue: unknown,
  defaults: V2RequestDefaults | undefined,
  config: McpAnalyticsConfig,
  options: V2AdapterOptions | undefined,
): V2Capture => {
  const ctx = isRecord(ctxValue) ? ctxValue : {};
  const mcpReq = isRecord(ctx.mcpReq) ? ctx.mcpReq : undefined;
  const envelope = isRecord(mcpReq?.envelope)
    ? (mcpReq.envelope as Record<string, unknown>)
    : undefined;
  const meta = isRecord(mcpReq?._meta)
    ? (mcpReq._meta as Record<string, unknown>)
    : undefined;
  const http = isRecord(ctx.http) ? ctx.http : undefined;
  const req = isRecord(http?.req) ? http.req : undefined;
  const reqHeaders = req?.headers;
  const headers = ((reqHeaders instanceof Headers || isRecord(reqHeaders))
    ? (reqHeaders as HeaderBag)
    : undefined) ?? defaults?.headers;
  const authInfo =
    (isRecord(http?.authInfo) ? (http.authInfo as RequestExtra["authInfo"]) : undefined)
    ?? defaults?.authInfo;

  const clientInfo = clientInfoFromEnvelope(envelope);

  // Session-id ladder (falling priority):
  //   1. `gen_ai.conversation.id` from the `baggage` _meta slot — the agent's
  //      own conversation identity, when the caller propagates it.
  //   2. The X-Armature-Session-Seed request header. When the request ALSO
  //      echoes an Mcp-Session-Id that was minted FROM that seed (the
  //      `wrapMcpHandler` legacy flow embeds the seed uuid in the
  //      `mcp_<name>_v_<version>_<uuid>` id), the two name the same session,
  //      so the richer identity-bearing id wins the rung — otherwise the two
  //      headers would split one legacy conversation into two sessions.
  //   3. Legacy-era session identity: `ctx.sessionId` (set only by sessionful
  //      legacy transports; under `createMcpHandler` the legacy leg is
  //      stateless and mints no Mcp-Session-Id, so it rarely fires there),
  //      then an `Mcp-Session-Id` REQUEST header a legacy client echoes —
  //      which is what `wrapMcpHandler` mints on legacy initialize responses.
  //   4. The stdio process-scoped id, only when there is no HTTP context at
  //      all (neither on the handler ctx nor on the factory request context).
  //   5. undefined — the event ships with a null hint and ingest buckets it.
  const seed = headers
    ? trimOrUndefined(headerValue(headers, SESSION_SEED_HEADER))
    : undefined;
  const echoedSessionId = headers
    ? trimOrUndefined(headerValue(headers, "mcp-session-id"))
    : undefined;
  const seedRung = seed !== undefined
    && echoedSessionId !== undefined
    && echoedSessionId.toLowerCase().endsWith(`_${seed.toLowerCase()}`)
    ? echoedSessionId
    : seed;
  const sessionId =
    conversationIdFromBaggage(meta?.[BAGGAGE_META_KEY])
    ?? seedRung
    ?? trimOrUndefined(ctx.sessionId)
    ?? echoedSessionId
    ?? (http == null && defaults?.hasHttpRequest !== true
      ? processScopedSessionId()
      : undefined);

  const extra: RequestExtra = {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(authInfo !== undefined ? { authInfo } : {}),
    ...(headers !== undefined ? { requestInfo: { headers } } : {}),
  };

  // The User-Agent header, so v2 sessions keep the per-session harness signal
  // v1 recorded (ingest's extractHarness reads metadata.user_agent). Captured
  // from the handler ctx's HTTP request headers with the factory-context
  // requestInfo fallback (the `headers` chain above), and stamped on
  // tool_call metadata too — session_init picks it up from
  // extra.requestInfo.headers in events.ts.
  const userAgent = headers
    ? trimOrUndefined(headerValue(headers, "user-agent"))
    : undefined;

  // Client identity is per-request on the 2026-07-28 revision, so it is
  // stamped on every tool_call event too — not only session_init — using the
  // same metadata keys. Contract keys still win on collision (events.ts).
  const metadataExtra: Record<string, unknown> = {
    // Which protocol leg served this request: a lifted `_meta` envelope
    // exists only on 2026-07-28 ("modern") requests; everything else came
    // through the legacy leg.
    protocol_era: envelope !== undefined ? "modern" : "legacy",
    ...(clientInfo?.name !== undefined ? { client_name: clientInfo.name } : {}),
    ...(clientInfo?.version !== undefined ? { client_version: clientInfo.version } : {}),
    ...(clientInfo?.protocolVersion !== undefined
      ? { protocol_version: clientInfo.protocolVersion }
      : {}),
    // Per-request clientCapabilities, same key and byte cap as session_init
    // (over-cap objects are dropped to null, never truncated into bad JSON).
    ...(isRecord(clientInfo?.capabilities)
      ? { capabilities: capCapabilities(clientInfo.capabilities) }
      : {}),
    ...(userAgent !== undefined ? { user_agent: userAgent } : {}),
    ...capRequestMeta(meta, config.armature?.redactSecrets !== false),
    // Integrator hook last: its keys win over the adapter-derived keys above
    // (contract keys still win over everything, events.ts).
    ...(safeMetadataHook(options?.metadata, ctxValue) ?? {}),
  };

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(clientInfo !== undefined ? { clientInfo } : {}),
    extra,
    ...(Object.keys(metadataExtra).length > 0 ? { metadataExtra } : {}),
  };
};

// ─── Recorder state (shared across per-request server instances) ────────────

const createV2RecorderState = (config: McpAnalyticsConfig): V2RecorderState => {
  const toolModes = new Map<string, TelemetryMode>();
  const core = createAnalyticsRecorderCore(config, {
    isToolTelemetryOwned: (name) => toolModes.get(name) === "owned",
  });
  return { core, config, toolModes };
};

// `createMcpHandler` runs its factory PER REQUEST (both eras), so there is no
// long-lived server instance to hang state off. Session-init dedupe and the
// privacy queue must outlive the server: they are keyed on the CONFIG object
// (WeakMap), so hoisting the config — the natural shape — shares one recorder
// across every request. A per-call fresh config object still converges at
// ingest (session_init event ids are content-addressed), it just re-emits.
const recorderStatesByConfig = new WeakMap<McpAnalyticsConfig, V2RecorderState>();
let defaultRecorderState: V2RecorderState | undefined;

const recorderStateFor = (config: McpAnalyticsConfig | undefined): V2RecorderState => {
  if (config === undefined || config === defaultMcpAnalyticsConfig) {
    defaultRecorderState ??= createV2RecorderState(defaultMcpAnalyticsConfig);
    return defaultRecorderState;
  }
  let state = recorderStatesByConfig.get(config);
  if (!state) {
    state = createV2RecorderState(config);
    recorderStatesByConfig.set(config, state);
  }
  return state;
};

/**
 * Drain the analytics pipeline tied to a config object (or the default
 * config). Call before process exit / serverless freeze when not using
 * `delivery: "await"` or a `schedule` hook.
 */
export const flushMcpAnalytics = (config?: McpAnalyticsConfig): Promise<void> => {
  return recorderStateFor(config).core.flush();
};

// ─── Tool wrapping ──────────────────────────────────────────────────────────

// v2 telemetry mode, resolved once per tool at wrap time — always against the
// tool's ORIGINAL schema, before any declareTelemetry decoration runs, so a
// telemetry property the ADAPTER added can never flip the tool to
// customer-owned ("owned" is reserved for schemas whose author declared
// telemetry themselves). By default the v2 adapter does not decorate input
// schemas, and "injected" means only: strip-and-export a `telemetry` argument
// if the client sends one. With `declareTelemetry: true` the advertised
// schema is additionally rebuilt to carry the telemetry property (see
// decorateAdvertisedSchema).
const resolveToolMode = (
  server: V2McpServerInternals,
  name: string,
  inputSchema: unknown,
  config: McpAnalyticsConfig,
): TelemetryMode => {
  let owned = false;
  try {
    // The SDK's own registration-time JSON conversion covers ANY Standard
    // Schema (zod, arktype, valibot, fromJsonSchema); the structural check on
    // the raw value is the fallback when the helper is absent or throws.
    const json = typeof server.toolInputSchemaJson === "function"
      ? server.toolInputSchemaJson(name)
      : undefined;
    owned = schemaDeclaresTelemetry(json) || schemaDeclaresTelemetry(inputSchema);
  } catch {
    owned = schemaDeclaresTelemetry(inputSchema);
  }
  if (owned) return "owned";
  return isCaptureEnabled(config) ? "injected" : "scrub";
};

// Builds the declareTelemetry replacement schema for one tool, or undefined
// when the tool must stay undecorated. Mechanism (chosen after probing the
// SDK, see also V2AdapterOptions.declareTelemetry):
//
//   1. `server.toolInputSchemaJson(name)` yields the exact JSON Schema
//      `tools/list` would advertise — the SDK's own registration-time
//      conversion, covering any Standard Schema vendor (zod v4, arktype,
//      valibot, fromJsonSchema) without this package converting anything
//      itself. Schema-less tools yield the SDK's empty object schema.
//   2. The telemetry property is added to that JSON (byte-identical
//      descriptions to v1 via createTelemetryJsonSchema). A top-level
//      `additionalProperties: false` needs no lifting: JSON Schema applies it
//      only to keys NOT in `properties`, so declaring `telemetry` makes it
//      pass validation while every other unknown key is still rejected.
//   3. `fromJsonSchema` wraps the decorated JSON back into a Standard Schema
//      whose `~standard.jsonSchema` returns it verbatim, and
//      `RegisteredTool.update({ paramsSchema })` swaps it in — invalidating
//      the SDK's memoized JSON so `tools/list`, the SEP-2243 pre-dispatch
//      header validation, and the Ajv input validation (which all run BEFORE
//      the analytics wrapper) uniformly see and accept `telemetry`. The
//      wrapper then strips it, so the customer callback receives args that
//      satisfy the original schema. Zod is bypassed entirely.
const decorateAdvertisedSchema = (
  server: V2McpServerInternals,
  name: string,
  config: McpAnalyticsConfig,
): unknown => {
  if (typeof server.toolInputSchemaJson !== "function") return undefined;
  try {
    const json = server.toolInputSchemaJson(name);
    if (!isRecord(json)) return undefined;
    // Only object roots can carry the property; a non-object `type` cannot be
    // a valid MCP input schema anyway. (`type` may be absent on zod
    // discriminated-union roots — those are object-shaped by construction.)
    if (json.type !== undefined && json.type !== "object") return undefined;
    const properties = isRecord(json.properties) ? json.properties : {};
    if ("telemetry" in properties) return undefined;
    return fromJsonSchema({
      ...json,
      type: "object",
      properties: { ...properties, telemetry: createTelemetryJsonSchema(config) },
    } as Parameters<typeof fromJsonSchema>[0]);
  } catch {
    // Conversion or rebuild failure: leave the tool undecorated rather than
    // risking its registration — strip-and-export still applies.
    return undefined;
  }
};

// Shallow snapshot of a tool result's envelope and its _meta, taken
// synchronously before the record pipeline runs: the v2 SDK stamps
// `io.modelcontextprotocol/serverInfo` into every 2026-era response's _meta
// AFTER the wrapped callback returns, so recording the live reference would
// capture a nondeterministically mutated object (the same race the Go SDK's
// -race build caught). The live object is still what the SDK receives.
const snapshotToolResult = (result: unknown): unknown => {
  if (!isRecord(result)) return result;
  const snapshot: Record<string, unknown> = { ...result };
  if (isRecord(result._meta)) snapshot._meta = { ...result._meta };
  return snapshot;
};

const wrapToolCallback = (
  state: V2RecorderState,
  name: string,
  // The SDK dispatches according to the REGISTERED schema — (args, ctx) when
  // present, (ctx) when absent — while the original callback expects arguments
  // per the schema the customer declared. The two differ when declareTelemetry
  // adds a schema to a previously schema-less tool, so both flags are needed
  // (same split as the v1 prototype patch in server.ts).
  originalHasInputSchema: boolean,
  registeredHasInputSchema: boolean,
  originalCallback: (...args: unknown[]) => unknown,
  defaults: V2RequestDefaults | undefined,
  options: V2AdapterOptions | undefined,
): ((...args: unknown[]) => Promise<unknown>) => {
  const wrapped = async (...callbackArgs: unknown[]) => {
    const rawArgs = registeredHasInputSchema ? callbackArgs[0] : {};
    const ctx = registeredHasInputSchema ? callbackArgs[1] : callbackArgs[0];
    const capture = captureV2Request(ctx, defaults, state.config, options);
    return state.core.instrumentToolCall(
      {
        name,
        args: rawArgs,
        telemetryMode: state.toolModes.get(name) ?? "injected",
        ctx,
        extra: capture.extra,
        captureResult: snapshotToolResult,
        ...(capture.sessionId !== undefined ? { sessionId: capture.sessionId } : {}),
        ...(capture.clientInfo !== undefined ? { clientInfo: capture.clientInfo } : {}),
        ...(capture.metadataExtra !== undefined
          ? { metadataExtra: capture.metadataExtra }
          : {}),
      },
      (strippedArgs) =>
        originalHasInputSchema
          ? originalCallback(strippedArgs, ctx)
          : originalCallback(ctx),
    );
  };
  (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED_CALLBACK] = true;
  return wrapped;
};

const instrumentRegisteredTool = (
  state: V2RecorderState,
  server: V2McpServerInternals,
  name: string,
  tool: unknown,
  defaults: V2RequestDefaults | undefined,
  options: V2AdapterOptions | undefined,
): void => {
  const registered = tool as V2RegisteredToolInternal;
  if (
    typeof registered?.update !== "function"
    || typeof registered?.handler !== "function"
  ) {
    return;
  }
  const handler = registered.handler as ((...args: unknown[]) => unknown) & {
    [WRAPPED_CALLBACK]?: boolean;
  };
  if (handler[WRAPPED_CALLBACK]) return;

  // Mode is resolved against the ORIGINAL schema, before decoration — an
  // adapter-added telemetry property must stay armature-owned (strip+export),
  // never customer-owned.
  const mode = resolveToolMode(server, name, registered.inputSchema, state.config);
  state.toolModes.set(name, mode);

  const originalHasInputSchema = registered.inputSchema !== undefined;
  // declareTelemetry only decorates tools in "injected" mode: an "owned"
  // schema already declares telemetry (the customer's contract), and "scrub"
  // means capture is off — advertising the field would solicit telemetry we
  // would then drop.
  const decoratedSchema = options?.declareTelemetry === true && mode === "injected"
    ? decorateAdvertisedSchema(server, name, state.config)
    : undefined;
  const registeredHasInputSchema = decoratedSchema !== undefined
    ? true
    : originalHasInputSchema;

  // `update(...)` is the SDK's public path: it swaps the stored handler (and,
  // when decorating, the input schema + description) AND regenerates the
  // schema-keyed executor in one step, so dispatch arity stays exactly what
  // the SDK uses for the registered inputSchema. A paramsSchema update also
  // drops the SDK's memoized JSON conversion, so tools/list and pre-dispatch
  // validation pick up the decorated schema.
  registered.update({
    ...(decoratedSchema !== undefined
      ? {
          paramsSchema: decoratedSchema,
          // Same idempotent description nudge as v1 (ARM-24).
          description: appendTelemetryHint(registered.description, {
            toolName: name,
            logLevel: state.config.armature?.descriptionLengthLogLevel,
          }),
        }
      : {}),
    callback: wrapToolCallback(
      state,
      name,
      originalHasInputSchema,
      registeredHasInputSchema,
      handler,
      defaults,
      options,
    ),
  });
};

let warnedNotWrappable = false;

const instrumentV2Server = <S>(
  server: S,
  state: V2RecorderState,
  defaults: V2RequestDefaults | undefined,
  options: V2AdapterOptions | undefined,
): S => {
  if (server === null || typeof server !== "object") return server;
  const internals = server as unknown as V2McpServerInternals & {
    [WRAPPED_CALLBACK]?: boolean;
  };
  if (internals[WRAPPED_CALLBACK]) return server;
  if (typeof internals.registerTool !== "function") {
    // A factory may return a low-level `Server` (no registerTool registry);
    // there is nothing to wrap there — leave it running rather than breaking
    // the server over analytics.
    if (!warnedNotWrappable) {
      warnedNotWrappable = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[mcp-analytics] withMcpAnalytics(v2) received a server without registerTool (a low-level Server?); tool calls will not be recorded for it.",
      );
    }
    return server;
  }
  Object.defineProperty(internals, WRAPPED_CALLBACK, {
    value: true,
    configurable: true,
  });

  // Tools registered BEFORE instrumentation (the instrumentedFactory shape:
  // the factory registers its tools, then the wrapper runs).
  if (isRecord(internals._registeredTools)) {
    for (const [name, tool] of Object.entries(internals._registeredTools)) {
      instrumentRegisteredTool(state, internals, name, tool, defaults, options);
    }
  }

  // Tools registered AFTER instrumentation: instance-level wrap (deliberately
  // not a prototype patch — the v2 packages ship distinct ESM/CJS builds with
  // distinct prototypes, and client/server bundle separate core copies, so
  // instance wrapping is the only targeting that always hits).
  const originalRegisterTool = internals.registerTool;
  Object.defineProperty(internals, "registerTool", {
    configurable: true,
    writable: true,
    value: function instrumentedRegisterTool(
      this: unknown,
      ...registerArgs: unknown[]
    ) {
      const registered = originalRegisterTool.apply(this, registerArgs);
      const name = registerArgs[0];
      if (typeof name === "string") {
        instrumentRegisteredTool(state, internals, name, registered, defaults, options);
      }
      return registered;
    },
  });

  return server;
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Instrument a v2 `McpServer` instance: every tool registered on it (before or
 * after this call) records a `tool_call` analytics event with the same wire
 * shape as the v1 SDK integration, plus a `session_init` on first sight of
 * each session key. Returns the same (mutated) server instance.
 *
 * Under `createMcpHandler` the factory runs per request — prefer
 * `instrumentedFactory`, or hoist the config object so every request shares
 * one recorder (delivery queue + session_init dedupe are keyed on it).
 *
 * `options` (see V2AdapterOptions): `declareTelemetry` advertises the
 * Armature telemetry property on each tool's schema (v1 parity, opt-in);
 * `metadata` adds per-event metadata keys.
 */
export const withMcpAnalytics = <S extends V2McpServerLike>(
  server: S,
  config?: McpAnalyticsConfig,
  options?: V2AdapterOptions,
): S => {
  return instrumentV2Server(server, recorderStateFor(config), undefined, options);
};

// The construction context createMcpHandler/serveStdio hand to factories.
type V2FactoryRequestContext = {
  era?: string;
  authInfo?: unknown;
  requestInfo?: unknown;
};

const defaultsFromFactoryContext = (
  contextValue: unknown,
): V2RequestDefaults | undefined => {
  if (!isRecord(contextValue)) return undefined;
  const context = contextValue as V2FactoryRequestContext;
  const requestInfo = context.requestInfo;
  const headers = isRecord(requestInfo) || requestInfo instanceof Request
    ? (requestInfo as { headers?: unknown }).headers
    : undefined;
  const authInfo = isRecord(context.authInfo)
    ? (context.authInfo as RequestExtra["authInfo"])
    : undefined;
  const usableHeaders = headers instanceof Headers || isRecord(headers)
    ? (headers as HeaderBag)
    : undefined;
  if (usableHeaders === undefined && authInfo === undefined && requestInfo === undefined) {
    return undefined;
  }
  return {
    ...(usableHeaders !== undefined ? { headers: usableHeaders } : {}),
    ...(authInfo !== undefined ? { authInfo } : {}),
    hasHttpRequest: requestInfo !== undefined,
  };
};

/**
 * Wrap a `createMcpHandler` / `serveStdio` factory so every server it produces
 * is instrumented with `withMcpAnalytics`. One recorder (privacy queue +
 * session_init dedupe) is shared across all servers the wrapped factory
 * creates, and the factory's `McpRequestContext` (`requestInfo`, `authInfo`)
 * backfills header-based capture when the handler ctx carries no HTTP request
 * (the low-level `Server` sets `ctx.http.authInfo` without `req`).
 */
export const instrumentedFactory = <TArgs extends unknown[], TResult>(
  factory: (...args: TArgs) => TResult,
  config?: McpAnalyticsConfig,
  options?: V2AdapterOptions,
): ((...args: TArgs) => TResult | Promise<Awaited<TResult>>) => {
  const state = recorderStateFor(config);
  return (...args: TArgs) => {
    const defaults = defaultsFromFactoryContext(args[0]);
    const produced = factory(...args);
    if (
      produced !== null
      && typeof produced === "object"
      && typeof (produced as { then?: unknown }).then === "function"
    ) {
      return Promise.resolve(produced as unknown as PromiseLike<Awaited<TResult>>).then(
        (server) => instrumentV2Server(server, state, defaults, options),
      );
    }
    return instrumentV2Server(produced, state, defaults, options);
  };
};

// ─── Handler-level wrapper (legacy-session repair) ──────────────────────────

/** Structural stand-in for the object `createMcpHandler` returns. */
export type V2McpHandlerLike = {
  fetch: (request: Request, options?: never) => Promise<Response>;
};

const SESSION_ID_HEADER = "mcp-session-id";

/**
 * Wrap a `createMcpHandler` handler's `fetch`.
 *
 * v2's `createMcpHandler` serves 2025-era clients through its stateless legacy
 * leg, which mints NO `Mcp-Session-Id` (and offers no option to) — so a
 * legacy client through a v2 handler silently loses session attribution.
 * This wrapper repairs that: on a legacy `initialize` request it mints an
 * identity-bearing session id (`mcp_<name>_v_<version>_<uuid>`, honoring
 * `X-Armature-Session-Seed` as the uuid seed — the same scheme as
 * `resolveStatelessHttpSession` in the v1 integration), attaches it as the
 * response's `Mcp-Session-Id`, records the session_init, and echoes the id on
 * later legacy responses. Conforming legacy clients echo the header on every
 * subsequent request, where rung 3 of the session-id ladder picks it up.
 *
 * Composable and optional: `withMcpAnalytics` / `instrumentedFactory` work
 * standalone (modern-era attribution needs no handler wrapper); pass the SAME
 * config object to both so they share one recorder. Modern-era requests pass
 * through this wrapper untouched (they carry no `initialize`).
 */
export const wrapMcpHandler = <H extends V2McpHandlerLike>(
  handler: H,
  config?: McpAnalyticsConfig,
): H => {
  const state = recorderStateFor(config);
  const inner = handler as H & {
    fetch: (...args: unknown[]) => Promise<Response>;
  };
  const originalFetch = inner.fetch.bind(handler);

  const withSessionIdHeader = (response: Response, sessionId: string): Response => {
    if (response.headers.get(SESSION_ID_HEADER)) return response;
    const headers = new Headers(response.headers);
    headers.set(SESSION_ID_HEADER, sessionId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const wrappedFetch = async (request: Request, ...rest: unknown[]) => {
    // createMcpHandler's fetch contract is `fetch(request, { authInfo })` —
    // the caller verifies the bearer token and hands the result in via the
    // options bag. Forward it into session_init actor resolution so custom
    // actorId/actorIdentifier resolvers see the same authInfo shape the
    // tool-call path receives.
    const fetchOptions = isRecord(rest[0]) ? rest[0] : undefined;
    const authInfo = isRecord(fetchOptions?.authInfo)
      ? (fetchOptions.authInfo as RequestExtra["authInfo"])
      : undefined;
    let session: ReturnType<typeof resolveStatelessHttpSession> | undefined;
    let body: unknown;
    if (request.method === "POST") {
      try {
        const raw = await request.clone().text();
        body = raw ? JSON.parse(raw) : undefined;
        // `initialize` exists only on the 2025 era, so `isInitialize` doubles
        // as the legacy detector; modern-era requests fall through untouched.
        session = resolveStatelessHttpSession({ body, headers: request.headers });
      } catch {
        session = undefined;
      }
    }

    const response = await originalFetch(request, ...rest);

    // `sessionId` is always minted on initialize; the check narrows the type
    // for the non-initialize case, where it is now optional.
    if (session?.isInitialize && session.sessionId && response.ok) {
      const mintedSessionId = session.sessionId;
      // Full-fidelity clientInfo from the initialize body: the minted id only
      // carries name/version, so without this the session_init would lose the
      // negotiated protocolVersion (and capabilities) — recorded here even
      // though the initialize landed on a throwaway per-request server
      // instance.
      const clientInfo = clientInfoFromInitializeBody(body);
      try {
        await state.core.recordSessionInit({
          sessionId: mintedSessionId,
          headers: request.headers,
          ...(clientInfo !== undefined ? { clientInfo } : {}),
          ...(authInfo !== undefined ? { authInfo } : {}),
          extra: {
            sessionId: mintedSessionId,
            requestInfo: { headers: request.headers },
            ...(authInfo !== undefined ? { authInfo } : {}),
          },
        });
      } catch {
        // Recording is best-effort; never break the MCP response over it.
      }
      return withSessionIdHeader(response, mintedSessionId);
    }

    // Echo an id the legacy client is already carrying, so it keeps carrying it.
    const echoed = request.headers.get(SESSION_ID_HEADER)?.trim();
    if (echoed) return withSessionIdHeader(response, echoed);
    return response;
  };

  return { ...handler, fetch: wrappedFetch } as H;
};

export type { AnalyticsRecorderCore } from "./recorder-core.js";
export type {
  AnalyticsEventKind,
  AnalyticsIngestBatch,
  AnalyticsIngestEvent,
  McpAnalyticsConfig,
  McpClientInfo,
  TelemetryArgs,
  TelemetryEmitter,
} from "./types.js";
export { defaultMcpAnalyticsConfig } from "./emit.js";
