import { createAnalyticsRecorder } from "./recorder.js";
import { decorateInputSchemaWithTelemetry } from "./schema.js";
import type {
  AnalyticsRecorder,
  InternalMcpAnalyticsConfig,
  McpAnalyticsConfig,
  RequestExtra,
} from "./types.js";

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

export type MastraTool = {
  id?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execute?: MastraToolExecute;
  [key: string]: unknown;
};

export type MastraToolMap = Record<string, MastraTool>;

export type MastraAdapterOptions = McpAnalyticsConfig & {
  resolveExtra?: (mastraContext: unknown) => RequestExtra | undefined;
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
    const extra = resolveExtra?.(mastraContext);
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

export const wrapMastraToolsWithRecorder = (
  tools: MastraToolMap,
  recorder: AnalyticsRecorder,
  config: InternalMcpAnalyticsConfig = {},
  options: { resolveExtra?: MastraAdapterOptions["resolveExtra"] } = {},
): MastraToolMap => {
  const out: MastraToolMap = {};
  for (const [key, tool] of Object.entries(tools)) {
    out[key] = wrapOneTool(key, tool, recorder, config, options.resolveExtra);
  }
  return out;
};

export const wrapMastraTools = (
  tools: MastraToolMap,
  options: MastraAdapterOptions = {},
): MastraToolMap => {
  const { resolveExtra, ...config } = options;
  const recorder = createAnalyticsRecorder(config);
  return wrapMastraToolsWithRecorder(tools, recorder, config, { resolveExtra });
};

export type MastraAnalytics = {
  recorder: AnalyticsRecorder;
  wrapTools: (tools: MastraToolMap) => MastraToolMap;
  flush: () => Promise<void>;
};

export const createMastraAnalytics = (
  options: MastraAdapterOptions = {},
): MastraAnalytics => {
  const { resolveExtra, ...config } = options;
  const recorder = createAnalyticsRecorder(config);
  return {
    recorder,
    wrapTools: (tools) =>
      wrapMastraToolsWithRecorder(tools, recorder, config, { resolveExtra }),
    flush: recorder.flush,
  };
};
