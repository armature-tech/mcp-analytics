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
  stripSdkDescriptionHint,
  createTelemetryJsonSchema,
  decorateInputSchemaWithTelemetry,
  isCaptureEnabled,
  schemaDeclaresTelemetry,
} from "./schema.js";
import { headerValue, isRecord, mergeRequestExtra } from "./utils.js";

// Adapter for punkpeye/fastmcp (npm `fastmcp`, v1-SDK based). fastmcp routes
// tool calls through its own low-level `new Server(...)` +
// `setRequestHandler(CallToolRequestSchema, ...)` dispatcher
// (fastmcp/dist/chunk-*.js `setupToolHandlers`), so the package root's
// `McpServer.prototype` patches never see those calls — a fastmcp server was
// previously unrecorded. This module wraps the `execute` function of the tool
// definition objects users pass to `server.addTool(...)` instead.
//
// Structural typing only: NO runtime or type dependency on the `fastmcp`
// package, and none on `@modelcontextprotocol/*` either (the shared record
// pipeline in recorder-core.ts is SDK-free).
//
// Verified fastmcp API facts this adapter is built on (fastmcp 4.12.1,
// dist/FastMCP.d.ts + dist/chunk-*.js `setupToolHandlers`):
//
// - `execute(args, context)` — `args` is the Standard-Schema-validated value
//   (or `undefined` when the tool declares no `parameters`); `context` carries
//   `client.version` (the SDK Server's `getClientVersion()`, i.e. the
//   `initialize` clientInfo), `log`, `reportProgress`, `streamContent`,
//   `elicit`, `requestId` (from `params._meta.requestId`, rarely present),
//   `session` (the value the user's `authenticate(request)` returned), and
//   `sessionId` (the `Mcp-Session-Id`; HTTP transports only).
// - Errors: a throwing `execute` is caught by fastmcp and converted into an
//   `isError: true` content result (`UserError` keeps its message verbatim,
//   anything else becomes "Tool '<name>' execution failed: <message>"). A
//   returned `isError: true` ContentResult passes through as-is. Both shapes
//   are recorded here as failed calls; the value returned to fastmcp is
//   untouched either way.
// - `tool.timeoutMs` races OUTSIDE `execute`: on timeout fastmcp returns a
//   `UserError` result while the execute promise keeps running. The analytics
//   event records the execute outcome (true handler duration/status), not the
//   timeout envelope.
//
// What fastmcp does NOT expose to the execute context — documented limits,
// not gaps this adapter papers over:
//
// - HTTP request headers are unreachable from `execute`. `authenticate(request)`
//   receives the `http.IncomingMessage`, but only what it copies into its
//   return value (= `context.session`) survives. The adapter therefore reads
//   `context.session.headers` when present (set `authenticate: async (req) =>
//   ({ headers: req.headers, ... })` to opt in) and offers `resolveExtra` for
//   anything else. Without that, the `x-armature-session-seed` and workflow
//   headers are invisible and `session_init` identity comes only from
//   `context.client.version`.
// - Client identity (`context.client.version`) is populated from the session's
//   `initialize` handshake. In fastmcp's **stateless** httpStream mode every
//   request builds a fresh session that never saw `initialize`, so it is
//   `undefined` there and tool calls record an unknown client — honest, since
//   nothing else in the execute context carries identity.
// - Tool input schemas are opaque Standard Schema objects that fastmcp
//   validates BEFORE `execute` (advertising `additionalProperties: false` via
//   xsschema's `strictJsonSchema`), so by default the adapter does NOT
//   decorate schemas with the `telemetry` field (same default, for the same
//   conversion-hazard reasons, as the v2 adapter). A `telemetry` argument that
//   still reaches `execute` (e.g. a passthrough zod object) is stripped and
//   exported per the contract; a schema that declares its own top-level
//   `telemetry` keeps owning it ("owned" mode); with capture off it is
//   stripped and dropped ("scrub").
// - `declareTelemetry: true` (opt-in, v2-adapter parity) decorates the tool
//   definition's `parameters` BEFORE `addTool` — the only decoration point
//   that works, because fastmcp regenerates the advertised `tools/list` schema
//   from the `parameters` Standard Schema held in its private `#tools`
//   (`strictJsonSchema(await toJsonSchema(tool.parameters))`), so no
//   registered artifact can be patched after the fact. Without it a fresh-
//   schema client is never told about `telemetry` and model-side telemetry
//   simply never arrives (verified live 2026-07-29 against fastmcp 4.12.1).

/** Header a caller can set to pin the analytics session id (matches the v1 stateless pattern and the v2 ladder). */
export const FASTMCP_SESSION_SEED_HEADER = "x-armature-session-seed";

// Wrapped execute functions and instrumented servers are tagged so re-wrapping
// (double `withFastmcpAnalytics`, `instrumentFastMCP` over pre-wrapped tools,
// double `instrumentFastMCP`) can never double-record a call.
const WRAPPED_EXECUTE = Symbol.for("armature.mcpAnalytics.fastmcp.wrappedExecute");
const WRAPPED_SERVER = Symbol.for("armature.mcpAnalytics.fastmcp.wrappedServer");

// ─── Minimal structural types ───────────────────────────────────────────────

// `args`/`context` are `any` for the same contravariance reason documented at
// length in mastra.ts (`MastraToolExecute`): fastmcp's `Tool<...>.execute`
// declares narrower params, and `unknown` here would force every caller to
// cast their tools in and out of the wrapper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FastmcpToolExecute = (args: any, context?: any) => unknown | Promise<unknown>;

// Optional-fields-only, no index signature — same structural-matching
// rationale as `MastraTool` (see mastra.ts). fastmcp's `Tool<...>` type is a
// strict structural subtype, and the `<T extends FastmcpToolLike>` generics
// below hand the caller back their exact tool type with every field
// (`annotations`, `canAccess`, `timeoutMs`, `_meta`, …) preserved by spread.
export type FastmcpToolLike = {
  name: string;
  description?: string;
  parameters?: unknown;
  outputSchema?: unknown;
  execute?: FastmcpToolExecute;
};

export type FastmcpAdapterOptions = McpAnalyticsConfig & {
  /**
   * Layered on top of the adapter's own context extraction; its values win
   * where both define a field (same contract as the Mastra adapter's
   * `resolveExtra`). The argument is fastmcp's execute `context`.
   */
  resolveExtra?: (fastmcpContext: unknown) => RequestExtra | undefined;
  /**
   * Transport hint for the stdio-fallback decision when no session signal is
   * reachable: `"stdio"` (default) buckets signal-less calls under the
   * process-scoped stdio session id; `"httpStream"` suppresses that fallback
   * so a long-lived HTTP server's anonymous sessions are not glued to one
   * process id. `instrumentFastMCP` sniffs the real transport from
   * `server.start(...)` and overrides this automatically.
   */
  transport?: "stdio" | "httpStream";
  /**
   * Advertise the Armature `telemetry` input property on every instrumented
   * tool's schema (v2-adapter parity, opt-in). The tool definition's
   * `parameters` is decorated BEFORE `addTool` — fastmcp regenerates the
   * advertised schema from that Standard Schema, so this is the only point
   * where decoration can take effect. Zod object parameters are `.extend`ed
   * with the optional telemetry field (byte-identical descriptions to the v1
   * integration); Standard JSON Schema parameters (fastmcp's
   * `jsonSchemaAdapter`) are re-wrapped so the advertised JSON gains the
   * `telemetry` property and validation accepts-then-forwards it (a top-level
   * `additionalProperties: false` keeps rejecting every OTHER undeclared key,
   * because `telemetry` becomes a declared property); schema-less tools gain a
   * telemetry-only parameters object (their `execute` still receives
   * `undefined`). The wrapper strips the argument before `execute` and exports
   * it — ownership is resolved against the original schema before decoration,
   * so adapter-added telemetry is always armature-owned, never customer-owned.
   *
   * Tools whose parameters are neither a zod object nor a Standard JSON
   * Schema (other Standard Schema vendors) are left undecorated — a
   * `telemetry` argument that reaches `execute` anyway is still stripped and
   * exported. `captureTelemetry: false` disables decoration entirely. Note the
   * returned tool keeps the caller's compile-time type while its runtime
   * `parameters` differ — hand it straight to `addTool`.
   */
  declareTelemetry?: boolean;
};

type FastmcpRecorderState = {
  core: AnalyticsRecorderCore;
  config: McpAnalyticsConfig;
  toolModes: Map<string, TelemetryMode>;
};

// Mutable so `instrumentFastMCP`'s `start(...)` sniff can flip it after tools
// were already wrapped.
type FastmcpRuntime = { assumeHttp: boolean };

// ─── Recorder state (shared per options object) ─────────────────────────────

// Keyed on the caller's options object so every wrap call that reuses the same
// options shares one recorder (privacy queue + session_init dedupe) — the same
// hoist-the-config contract as the v2 adapter. A fresh options object per call
// still converges at ingest (event ids are content-addressed).
const recorderStatesByOptions = new WeakMap<FastmcpAdapterOptions, FastmcpRecorderState>();
let defaultRecorderState: FastmcpRecorderState | undefined;

const createRecorderState = (config: McpAnalyticsConfig): FastmcpRecorderState => {
  const toolModes = new Map<string, TelemetryMode>();
  const core = createAnalyticsRecorderCore(config, {
    isToolTelemetryOwned: (name) => toolModes.get(name) === "owned",
  });
  return { core, config, toolModes };
};

const recorderStateFor = (
  options: FastmcpAdapterOptions | undefined,
): FastmcpRecorderState => {
  if (options === undefined || options === defaultMcpAnalyticsConfig) {
    defaultRecorderState ??= createRecorderState(defaultMcpAnalyticsConfig);
    return defaultRecorderState;
  }
  let state = recorderStatesByOptions.get(options);
  if (!state) {
    const {
      resolveExtra: _resolveExtra,
      transport: _transport,
      declareTelemetry: _declareTelemetry,
      ...config
    } = options;
    state = createRecorderState(config);
    recorderStatesByOptions.set(options, state);
  }
  return state;
};

/**
 * Drain the analytics pipeline tied to an options object (or the default
 * config). Call before process exit when not using `delivery: "await"` or a
 * `schedule` hook.
 */
export const flushFastmcpAnalytics = (
  options?: FastmcpAdapterOptions,
): Promise<void> => {
  return recorderStateFor(options).core.flush();
};

// ─── Per-call capture ───────────────────────────────────────────────────────

const trimOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// `context.client.version` is the v1 SDK's `Implementation` from the session's
// `initialize` handshake ({ name, version }), or undefined when the session
// never saw one (fastmcp stateless httpStream mode).
const clientInfoFromContext = (context: unknown): McpClientInfo | undefined => {
  if (!isRecord(context)) return undefined;
  const client = isRecord(context.client) ? context.client : undefined;
  const version = isRecord(client?.version) ? client.version : undefined;
  const name = trimOrUndefined(version?.name);
  if (name === undefined) return undefined;
  const clientVersion = trimOrUndefined(version?.version);
  return { name, ...(clientVersion !== undefined ? { version: clientVersion } : {}) };
};

const headerBagFrom = (value: unknown): HeaderBag | undefined => {
  if (value instanceof Headers) return value;
  return isRecord(value) ? (value as HeaderBag) : undefined;
};

/**
 * The extra the adapter derives from fastmcp's execute context on its own:
 * `context.sessionId` (the Mcp-Session-Id fastmcp surfaces on HTTP
 * transports), request headers IF the user's `authenticate` copied them into
 * the auth object as `headers` (`context.session.headers`), and the four
 * actor-seed fields (`token`/`clientId`/`apiKey`/`principalId`) when the auth
 * object carries them as strings. Exported for reuse in custom `resolveExtra`
 * implementations.
 */
export const defaultFastmcpResolveExtra = (
  context: unknown,
): RequestExtra | undefined => {
  if (!isRecord(context)) return undefined;
  const result: RequestExtra = {};

  const sessionId = trimOrUndefined(context.sessionId);
  if (sessionId !== undefined) result.sessionId = sessionId;

  const session = isRecord(context.session) ? context.session : undefined;
  const headers = headerBagFrom(session?.headers);
  if (headers !== undefined) result.requestInfo = { headers };

  if (session) {
    // Same four-field narrowing as the Mastra adapter: never forward arbitrary
    // auth-object properties down the analytics pipeline.
    const authInfo: NonNullable<RequestExtra["authInfo"]> = {};
    if (typeof session.token === "string") authInfo.token = session.token;
    if (typeof session.clientId === "string") authInfo.clientId = session.clientId;
    if (typeof session.apiKey === "string") authInfo.apiKey = session.apiKey;
    if (typeof session.principalId === "string") {
      authInfo.principalId = session.principalId;
    }
    if (Object.keys(authInfo).length > 0) result.authInfo = authInfo;
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

// fastmcp telemetry mode, resolved once per tool at wrap time. Schemas are
// never decorated (see module comment), so "injected" here means only:
// strip-and-export a `telemetry` argument if one reaches `execute`.
const resolveFastmcpToolMode = (
  parameters: unknown,
  config: McpAnalyticsConfig,
): TelemetryMode => {
  const owned =
    schemaDeclaresTelemetry(parameters)
    || schemaDeclaresTelemetry(standardSchemaJson(parameters));
  if (owned) return "owned";
  return isCaptureEnabled(config) ? "injected" : "scrub";
};

// fastmcp's `jsonSchemaAdapter` (and any Standard JSON Schema-extension
// schema) carries the JSON Schema it was built from at
// `~standard.jsonSchema.input()` — the same object `schemaDeclaresTelemetry`
// already understands.
const standardSchemaJson = (parameters: unknown): unknown => {
  if (!isRecord(parameters)) return undefined;
  const standard = parameters["~standard"];
  if (!isRecord(standard)) return undefined;
  const jsonSchema = standard.jsonSchema;
  if (!isRecord(jsonSchema) || typeof jsonSchema.input !== "function") {
    return undefined;
  }
  try {
    return (jsonSchema.input as () => unknown)();
  } catch {
    return undefined;
  }
};

// ─── declareTelemetry: parameters decoration ────────────────────────────────

// Minimal structural view of a Standard Schema's `~standard`, plus the JSON
// Schema extension fastmcp's `jsonSchemaAdapter` implements.
type StandardSchemaInternals = {
  vendor?: unknown;
  version?: unknown;
  validate: (value: unknown) => unknown;
  jsonSchema?: {
    input?: (...args: unknown[]) => unknown;
    output?: (...args: unknown[]) => unknown;
  };
};

const standardInternalsOf = (
  parameters: unknown,
): StandardSchemaInternals | undefined => {
  if (!isRecord(parameters)) return undefined;
  const standard = parameters["~standard"];
  if (!isRecord(standard) || typeof standard.validate !== "function") {
    return undefined;
  }
  return standard as StandardSchemaInternals;
};

// Adds the telemetry property to a JSON object schema. `additionalProperties:
// false` needs no lifting — JSON Schema applies it only to keys NOT in
// `properties`, so declaring `telemetry` makes it pass while every other
// unknown key is still rejected (the same fact the v2 adapter's
// decorateAdvertisedSchema relies on). Non-object roots pass through
// untouched.
const decorateJsonWithTelemetry = (
  json: unknown,
  config: McpAnalyticsConfig,
): unknown => {
  if (!isRecord(json)) return json;
  if (json.type !== undefined && json.type !== "object") return json;
  const properties = isRecord(json.properties) ? json.properties : {};
  if ("telemetry" in properties) return json;
  return {
    ...json,
    type: "object",
    properties: { ...properties, telemetry: createTelemetryJsonSchema(config) },
  };
};

// Re-wraps a Standard JSON Schema parameters object (fastmcp's
// `jsonSchemaAdapter`, or any `~standard.jsonSchema` carrier): the advertised
// JSON gains the telemetry property, while validation splits `telemetry` off,
// delegates the rest to the ORIGINAL validator verbatim (so the user's ajv
// semantics — including `additionalProperties: false` on their own keys — are
// preserved exactly), and re-attaches it to the validated value for the
// analytics wrapper to strip. A non-record `telemetry` is left in place and
// hits the original validator unchanged, same as before decoration.
const decorateStandardJsonSchemaParameters = (
  original: StandardSchemaInternals,
  config: McpAnalyticsConfig,
): unknown => {
  const originalInput = original.jsonSchema?.input;
  const originalOutput = original.jsonSchema?.output ?? originalInput;
  return {
    "~standard": {
      vendor: original.vendor,
      version: original.version ?? 1,
      jsonSchema: {
        input: (...args: unknown[]) =>
          decorateJsonWithTelemetry(originalInput?.(...args), config),
        output: (...args: unknown[]) =>
          decorateJsonWithTelemetry(originalOutput?.(...args), config),
      },
      validate: async (value: unknown) => {
        if (!isRecord(value) || !isRecord(value.telemetry)) {
          return original.validate(value);
        }
        const { telemetry, ...rest } = value;
        const result = await original.validate(rest);
        if (!isRecord(result) || result.issues !== undefined) return result;
        return isRecord(result.value)
          ? { value: { ...result.value, telemetry } }
          : result;
      },
    },
  };
};

// Telemetry-only parameters for a previously schema-less tool. fastmcp never
// validated its arguments before (schema-less tools skip validation and get
// `execute(undefined, ...)`), so validation stays fully permissive; the
// wrapper restores `undefined` for the original execute.
const telemetryOnlyParameters = (config: McpAnalyticsConfig): unknown => {
  const json = {
    type: "object",
    properties: { telemetry: createTelemetryJsonSchema(config) },
  };
  return {
    "~standard": {
      vendor: "armature-mcp-analytics",
      version: 1,
      jsonSchema: { input: () => json, output: () => json },
      validate: (value: unknown) => ({ value }),
    },
  };
};

// The decorated replacement for a tool's `parameters`, or undefined when the
// tool must stay undecorated (unrecognized schema shape — strip-and-export
// still applies to any telemetry that reaches execute).
const decorateFastmcpParameters = (
  parameters: unknown,
  config: McpAnalyticsConfig,
): unknown => {
  if (parameters === undefined) {
    return telemetryOnlyParameters(config);
  }
  // Zod object (v3 or v4 — decorateInputSchemaWithTelemetry discriminates the
  // major): extend with the telemetry field, so fastmcp's own pre-execute
  // validation keeps `telemetry` (a plain v3 object strips undeclared keys, a
  // strict one rejects them — declared keys always survive).
  if (
    isRecord(parameters)
    && "shape" in parameters
    && typeof parameters.extend === "function"
  ) {
    try {
      return decorateInputSchemaWithTelemetry(parameters, config);
    } catch {
      return undefined;
    }
  }
  const original = standardInternalsOf(parameters);
  if (original === undefined) return undefined;
  const json = standardSchemaJson(parameters);
  if (!isRecord(json)) return undefined;
  // Only object roots can carry the property; `type` may legitimately be
  // absent on object-shaped roots.
  if (json.type !== undefined && json.type !== "object") return undefined;
  return decorateStandardJsonSchemaParameters(original, config);
};

// ─── Tool wrapping ──────────────────────────────────────────────────────────

const wrapFastmcpTool = <T extends FastmcpToolLike>(
  tool: T,
  state: FastmcpRecorderState,
  runtime: FastmcpRuntime,
  options: FastmcpAdapterOptions | undefined,
): T => {
  if (typeof tool?.execute !== "function") return tool;
  const originalExecute = tool.execute as FastmcpToolExecute & {
    [WRAPPED_EXECUTE]?: boolean;
  };
  if (originalExecute[WRAPPED_EXECUTE]) return tool;
  const resolveExtra = options?.resolveExtra;

  const toolName = tool.name;
  // Mode is resolved against the ORIGINAL parameters, before any
  // declareTelemetry decoration — a telemetry property the ADAPTER added must
  // stay armature-owned (strip + export), never customer-owned.
  const mode = resolveFastmcpToolMode(tool.parameters, state.config);
  state.toolModes.set(toolName, mode);

  // declareTelemetry only decorates tools in "injected" mode: an "owned"
  // schema already declares telemetry (the customer's contract), and "scrub"
  // means capture is off — advertising the field would solicit telemetry we
  // would then drop.
  const decoratedParameters = options?.declareTelemetry === true && mode === "injected"
    ? decorateFastmcpParameters(tool.parameters, state.config)
    : undefined;
  // A decorated previously-schema-less tool now receives validated args from
  // fastmcp, but its execute was written for `undefined`.
  const restoreUndefinedArgs =
    decoratedParameters !== undefined && tool.parameters === undefined;

  const wrappedExecute: FastmcpToolExecute = (args, context) => {
    const base = defaultFastmcpResolveExtra(context);
    const override = resolveExtra?.(context);
    const extra = mergeRequestExtra(base, override);
    const headers = extra?.requestInfo?.headers;

    // Session-id ladder (falling priority):
    //   1. An explicit `resolveExtra` sessionId — the user override.
    //   2. The X-Armature-Session-Seed header, when headers are reachable
    //      through `context.session.headers` / `resolveExtra`.
    //   3. `context.sessionId` — the Mcp-Session-Id fastmcp surfaces (HTTP
    //      transports; stateful mode mints it, stateless echoes the client's).
    //   4. An `mcp-session-id` value inside reachable headers, then — only
    //      when NO headers are reachable and the transport is not known to be
    //      HTTP — the stdio process-scoped id (both rungs live in
    //      recorder-core's resolveSessionId).
    //   5. undefined — the event ships with a null hint and ingest buckets it.
    const seed = trimOrUndefined(headerValue(headers, FASTMCP_SESSION_SEED_HEADER));
    const sessionId = override?.sessionId ?? seed ?? base?.sessionId;
    // `{}` (not undefined) when the transport is known to be HTTP: recorder-
    // core's stdio fallback keys on "no headers at all", and a long-lived HTTP
    // server must not glue its anonymous sessions to one process id.
    const effectiveHeaders = headers ?? (runtime.assumeHttp ? {} : undefined);
    const clientInfo = clientInfoFromContext(context);

    return state.core.instrumentToolCall(
      {
        name: toolName,
        args,
        telemetryMode: state.toolModes.get(toolName) ?? mode,
        ctx: context,
        ...(extra !== undefined ? { extra } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(effectiveHeaders !== undefined ? { headers: effectiveHeaders } : {}),
        ...(extra?.authInfo !== undefined ? { authInfo: extra.authInfo } : {}),
        ...(clientInfo !== undefined ? { clientInfo } : {}),
        // Deliberately NOT forwarding `context.requestId` as the event request
        // id: it is client-supplied `_meta` data, and the contract (see
        // TELEMETRY-CONTRACT.md, "tool_call request-id normalization") wants a
        // freshly minted per-call id, not a transport-controlled seed.
      },
      // fastmcp calls execute(undefined, context) for tools without
      // `parameters`; extractTelemetryArguments passes non-records through
      // untouched, so `strippedArgs` is exactly what fastmcp supplied then.
      (strippedArgs) =>
        originalExecute(restoreUndefinedArgs ? undefined : strippedArgs, context),
    );
  };
  (wrappedExecute as unknown as Record<PropertyKey, unknown>)[WRAPPED_EXECUTE] = true;

  if (decoratedParameters === undefined) {
    return { ...tool, execute: wrappedExecute };
  }
  // The cast: decoration intentionally swaps `parameters` for a schema whose
  // runtime shape differs from the caller's declared type (documented on the
  // option) — every other field still passes through by spread.
  return {
    ...tool,
    parameters: decoratedParameters,
    // Never adds text; removes SDK hint suffixes from earlier releases.
    description: stripSdkDescriptionHint(tool.description),
    execute: wrappedExecute,
  } as T;
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Wrap fastmcp tool definition object(s) before handing them to
 * `server.addTool(...)` / `server.addTools(...)`: every call to the tool
 * records a `tool_call` analytics event (timing, ok/error — including
 * fastmcp's isError results and thrown errors — input/output previews) plus a
 * `session_init` on first sight of each session key. The tool's result and
 * every other field (`annotations`, `canAccess`, `timeoutMs`, `_meta`, …)
 * pass through unchanged; wrapping an already-wrapped tool is a no-op.
 *
 * Hoist the options object — the recorder (delivery queue + session_init
 * dedupe) is keyed on it. On an httpStream deployment pass
 * `transport: "httpStream"` (or use `instrumentFastMCP`, which sniffs it from
 * `server.start`).
 */
export function withFastmcpAnalytics<T extends FastmcpToolLike>(
  tool: T,
  options?: FastmcpAdapterOptions,
): T;
export function withFastmcpAnalytics<T extends FastmcpToolLike>(
  tools: T[],
  options?: FastmcpAdapterOptions,
): T[];
export function withFastmcpAnalytics<T extends FastmcpToolLike>(
  toolOrTools: T | T[],
  options?: FastmcpAdapterOptions,
): T | T[] {
  const state = recorderStateFor(options);
  const runtime: FastmcpRuntime = {
    assumeHttp: options?.transport === "httpStream",
  };
  if (Array.isArray(toolOrTools)) {
    return toolOrTools.map((tool) =>
      wrapFastmcpTool(tool, state, runtime, options),
    );
  }
  return wrapFastmcpTool(toolOrTools, state, runtime, options);
}

/** Structural stand-in for a `FastMCP` server: anything with `addTool`. */
export type FastMCPLike = {
  addTool: (tool: never) => unknown;
};

type FastMCPInternals = {
  addTool?: (...args: unknown[]) => unknown;
  addTools?: (...args: unknown[]) => unknown;
  start?: (...args: unknown[]) => unknown;
};

// Mirrors fastmcp's own `#parseRuntimeConfig` precedence exactly:
// `start` options → `--transport` CLI arg (accepting the `http-stream` alias)
// → `FASTMCP_TRANSPORT` env → "stdio".
const sniffFastmcpTransport = (startOptions: unknown): "stdio" | "httpStream" => {
  const explicit = isRecord(startOptions) ? startOptions.transportType : undefined;
  if (explicit === "httpStream" || explicit === "stdio") return explicit;
  const args = typeof process !== "undefined" ? process.argv.slice(2) : [];
  const index = args.findIndex((arg) => arg === "--transport");
  const cliValue = index !== -1 ? args[index + 1] : undefined;
  const fromCli = cliValue === "http-stream" ? "httpStream" : cliValue;
  const fromEnv = typeof process !== "undefined"
    ? process.env.FASTMCP_TRANSPORT
    : undefined;
  const resolved = fromCli || fromEnv || "stdio";
  return resolved === "httpStream" ? "httpStream" : "stdio";
};

/**
 * Instrument a `FastMCP` server instance-level (structurally typed — no
 * import of the fastmcp package): every tool passed to `addTool`/`addTools`
 * AFTER this call is wrapped with `withFastmcpAnalytics` semantics, and
 * `server.start(...)` is sniffed for the real transport so httpStream
 * deployments automatically opt out of the stdio session fallback.
 *
 * Limitation, stated rather than papered over: fastmcp keeps already-added
 * tools in a private `#tools` field this function cannot reach — call it
 * BEFORE `addTool`, or wrap earlier tools with `withFastmcpAnalytics`
 * (pre-wrapped tools pass through here without double-recording). Returns the
 * same (mutated) server; instrumenting twice is a no-op.
 */
export const instrumentFastMCP = <S extends FastMCPLike>(
  server: S,
  options?: FastmcpAdapterOptions,
): S => {
  if (server === null || typeof server !== "object") return server;
  const internals = server as unknown as FastMCPInternals & {
    [WRAPPED_SERVER]?: boolean;
  };
  if (internals[WRAPPED_SERVER]) return server;
  if (typeof internals.addTool !== "function") return server;
  Object.defineProperty(internals, WRAPPED_SERVER, {
    value: true,
    configurable: true,
  });

  const state = recorderStateFor(options);
  const runtime: FastmcpRuntime = {
    assumeHttp: options?.transport === "httpStream",
  };
  const wrap = (tool: unknown) =>
    isRecord(tool)
      ? wrapFastmcpTool(tool as FastmcpToolLike, state, runtime, options)
      : tool;

  const originalAddTool = internals.addTool;
  Object.defineProperty(internals, "addTool", {
    configurable: true,
    writable: true,
    value: function instrumentedAddTool(this: unknown, ...args: unknown[]) {
      return originalAddTool.apply(this, [wrap(args[0]), ...args.slice(1)]);
    },
  });

  // fastmcp's addTools does NOT delegate to addTool (both mutate `#tools`
  // directly), so it needs its own wrap.
  const originalAddTools = internals.addTools;
  if (typeof originalAddTools === "function") {
    Object.defineProperty(internals, "addTools", {
      configurable: true,
      writable: true,
      value: function instrumentedAddTools(this: unknown, ...args: unknown[]) {
        const tools = Array.isArray(args[0]) ? args[0].map(wrap) : args[0];
        return originalAddTools.apply(this, [tools, ...args.slice(1)]);
      },
    });
  }

  const originalStart = internals.start;
  if (typeof originalStart === "function") {
    Object.defineProperty(internals, "start", {
      configurable: true,
      writable: true,
      value: function instrumentedStart(this: unknown, ...args: unknown[]) {
        // The started transport is ground truth; it overrides the
        // `transport` option hint. `connect(transport)` (the in-process/test
        // path) never runs this and keeps the stdio-like default.
        runtime.assumeHttp = sniffFastmcpTransport(args[0]) === "httpStream";
        return originalStart.apply(this, args);
      },
    });
  }

  return server;
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
