import { createAnalyticsRecorder } from "./recorder.js";
import { decorateInputSchemaWithTelemetry } from "./schema.js";
import type {
  AnalyticsRecorder,
  HeaderBag,
  InternalMcpAnalyticsConfig,
  McpAnalyticsConfig,
  RequestExtra,
} from "./types.js";
import { isRecord } from "./utils.js";

// `inputData` and `context` are `any` (not `unknown`) on purpose. Mastra's
// `createTool({...}).execute` is typed
// `(inputData: TInput, context: ToolExecutionContext<TInput>) => Promise<TOutput>`,
// and function params are contravariant: a function declaring narrower params is
// not assignable to one declaring `unknown`. With `unknown` here, every Mastra
// adapter user had to cast their tool map in and out of `wrapMastraTools` just
// to satisfy `tsc`. `any` opts both params out of variance checks while preserving
// the SDK's structural-typing-only relationship with `@mastra/*` — we still import
// nothing from Mastra at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MastraToolExecute = (inputData: any, context?: any) => unknown | Promise<unknown>;

// All fields are optional and the type carries NO index signature on purpose.
// Mastra's concrete `Tool<...>` class (from `@mastra/core/tools`) has a
// `#private` brand and only the fields below in its public surface — assigning
// a real `Tool<...>` to a structural type that demanded `[key: string]: unknown`
// failed because the brand makes the class instance non-structural, forcing
// every Mastra integrator to write `as unknown as MastraToolMap` at the
// `wrapMastraTools` call site. Without the index signature, the structural
// match only checks the listed optional fields, so the class instance is
// assignable cleanly. The trade-off: object-literal inline tools with extra
// fields would normally hit the excess-property check — but every call site
// uses the generic `<T extends MastraToolMap>` constraint, which infers `T`
// from the user's literal first and then checks that `T` is assignable, side-
// stepping excess-property checking on literals.
export type MastraTool = {
  id?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execute?: MastraToolExecute;
};

export type MastraToolMap = Record<string, MastraTool>;

export type MastraAdapterOptions = McpAnalyticsConfig & {
  resolveExtra?: (mastraContext: unknown) => RequestExtra | undefined;
};

const readMcpExtra = (mastraContext: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(mastraContext)) return undefined;

  // Direct path: context.mcp.extra (the second argument Mastra's MCPServer
  // passes into `execute` for tools invoked over MCP).
  const mcp = mastraContext.mcp;
  if (isRecord(mcp) && isRecord(mcp.extra)) return mcp.extra;

  // Fallback: context.requestContext.get("mcp.extra") — some Mastra setups
  // route the MCP extra through RuntimeContext under that key.
  const requestContext = mastraContext.requestContext;
  if (
    isRecord(requestContext) &&
    typeof (requestContext as { get?: unknown }).get === "function"
  ) {
    const fromContext = (requestContext as { get: (k: string) => unknown }).get(
      "mcp.extra",
    );
    if (isRecord(fromContext)) return fromContext;
  }
  return undefined;
};

export const defaultMastraResolveExtra = (
  mastraContext: unknown,
): RequestExtra | undefined => {
  const mcpExtra = readMcpExtra(mastraContext);
  if (!mcpExtra) return undefined;

  const result: RequestExtra = {};

  if (typeof mcpExtra.sessionId === "string" && mcpExtra.sessionId.length > 0) {
    result.sessionId = mcpExtra.sessionId;
  }
  const requestId = mcpExtra.requestId;
  if (typeof requestId === "string" || typeof requestId === "number") {
    result.requestId = requestId;
  }
  if (isRecord(mcpExtra.requestInfo)) {
    const headers = (mcpExtra.requestInfo as { headers?: unknown }).headers;
    if (headers !== undefined) {
      result.requestInfo = { headers: headers as HeaderBag };
    }
  }
  if (isRecord(mcpExtra.authInfo)) {
    // Narrow to the four fields `resolveActorSeed` / `buildSessionInitEvent`
    // actually consume — don't forward arbitrary unrelated properties from a
    // host-supplied object down the analytics pipeline.
    const incoming = mcpExtra.authInfo as Record<string, unknown>;
    const authInfo: NonNullable<RequestExtra["authInfo"]> = {};
    if (typeof incoming.token === "string") authInfo.token = incoming.token;
    if (typeof incoming.clientId === "string") authInfo.clientId = incoming.clientId;
    if (typeof incoming.apiKey === "string") authInfo.apiKey = incoming.apiKey;
    if (typeof incoming.principalId === "string") {
      authInfo.principalId = incoming.principalId;
    }
    if (Object.keys(authInfo).length > 0) result.authInfo = authInfo;
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

const mergeExtra = (
  base: RequestExtra | undefined,
  override: RequestExtra | undefined,
): RequestExtra | undefined => {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    ...(base.requestInfo || override.requestInfo
      ? {
          requestInfo: {
            ...(base.requestInfo ?? {}),
            ...(override.requestInfo ?? {}),
          },
        }
      : {}),
    ...(base.authInfo || override.authInfo
      ? {
          authInfo: {
            ...(base.authInfo ?? {}),
            ...(override.authInfo ?? {}),
          },
        }
      : {}),
  };
};

const wrapOneTool = (
  toolKey: string,
  tool: MastraTool,
  recorder: AnalyticsRecorder,
  config: InternalMcpAnalyticsConfig,
  resolveExtra?: (mastraContext: unknown) => RequestExtra | undefined,
): MastraTool => {
  if (typeof tool?.execute !== "function") {
    return tool;
  }

  const originalExecute = tool.execute;
  const toolName = tool.id ?? toolKey;
  const decoratedInputSchema =
    tool.inputSchema === undefined
      ? undefined
      : decorateInputSchemaWithTelemetry(tool.inputSchema, config);

  const wrappedExecute: MastraToolExecute = (inputData, mastraContext) => {
    // Always extract standard Mastra MCP context (`context.mcp.extra` or the
    // `requestContext.get("mcp.extra")` fallback). A user-supplied
    // `resolveExtra` layers on top — its values win where both define a field,
    // so it doubles as an override and an extension point.
    const extra = mergeExtra(
      defaultMastraResolveExtra(mastraContext),
      resolveExtra?.(mastraContext),
    );
    return recorder.instrumentToolCall(
      {
        name: toolName,
        args: inputData,
        ctx: mastraContext,
        extra,
        sessionId: extra?.sessionId,
        requestId:
          extra?.requestId === undefined ? undefined : String(extra.requestId),
        authInfo: extra?.authInfo,
        headers: extra?.requestInfo?.headers,
      },
      (strippedArgs) => originalExecute(strippedArgs, mastraContext),
    );
  };

  return {
    ...tool,
    ...(decoratedInputSchema !== undefined
      ? { inputSchema: decoratedInputSchema }
      : {}),
    execute: wrappedExecute,
  };
};

// Generic over the input map so the return value keeps the customer's exact
// tool-map type (e.g. `Record<string, AutumnTool>`). Without this, every Mastra
// caller had to do `wrapMastraTools(myTools as unknown as MastraToolMap, ...) as
// unknown as typeof myTools` because `MCPServer({ tools })` wants the narrower
// type back. The `T extends MastraToolMap` constraint lets us still operate on
// the values structurally — Mastra's `createTool({...})` shape is a strict
// subtype of `MastraTool` (id/inputSchema/outputSchema/execute), so any tool map
// passes the constraint without a cast.
export const wrapMastraToolsWithRecorder = <T extends MastraToolMap>(
  tools: T,
  recorder: AnalyticsRecorder,
  config: InternalMcpAnalyticsConfig = {},
  options: { resolveExtra?: MastraAdapterOptions["resolveExtra"] } = {},
): T => {
  const out: MastraToolMap = {};
  for (const [key, tool] of Object.entries(tools)) {
    out[key] = wrapOneTool(key, tool, recorder, config, options.resolveExtra);
  }
  return out as T;
};

export const wrapMastraTools = <T extends MastraToolMap>(
  tools: T,
  options: MastraAdapterOptions = {},
): T => {
  const { resolveExtra, ...config } = options;
  const recorder = createAnalyticsRecorder(config);
  return wrapMastraToolsWithRecorder(tools, recorder, config, { resolveExtra });
};

export type MastraAnalytics = {
  recorder: AnalyticsRecorder;
  wrapTools: <T extends MastraToolMap>(tools: T) => T;
  flush: () => Promise<void>;
};

export const createMastraAnalytics = (
  options: MastraAdapterOptions = {},
): MastraAnalytics => {
  const { resolveExtra, ...config } = options;
  const recorder = createAnalyticsRecorder(config);
  return {
    recorder,
    wrapTools: <T extends MastraToolMap>(tools: T) =>
      wrapMastraToolsWithRecorder(tools, recorder, config, { resolveExtra }),
    flush: recorder.flush,
  };
};
