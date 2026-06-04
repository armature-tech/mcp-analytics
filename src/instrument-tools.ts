import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAnalyticsRecorder } from "./recorder.js";
import type {
  AnalyticsRecorder,
  McpAnalyticsConfig,
  RegisteredToolHandler,
  ToolRegistration,
} from "./types.js";

// Canonical shape `instrumentMcpServerTools` registers on the McpServer. A
// caller-supplied `mapTool` converts an arbitrary registry entry into this
// shape; if the caller's registry already matches it, `mapTool` can be omitted.
export type InstrumentedTool = ToolRegistration & {
  handler: RegisteredToolHandler<unknown, unknown>;
};

type BaseInstrumentOptions = {
  server: McpServer;
  config?: McpAnalyticsConfig;
};

// Two-overload surface so `mapTool` is *required* whenever the caller's
// registry shape (`TDef`) is not already assignable to `InstrumentedTool`.
// Without this, a custom-shape registry compiled cleanly without a mapper, the
// identity cast laundered every entry into `InstrumentedTool`, and the first
// tool invocation threw "handler is not a function" at runtime.
export type InstrumentMcpServerToolsOptions<TDef> = BaseInstrumentOptions & {
  tools: TDef[] | Record<string, TDef>;
  mapTool?: (def: TDef, key?: string) => InstrumentedTool;
};

export type InstrumentMcpServerToolsResult = {
  server: McpServer;
  recorder: AnalyticsRecorder;
};

// Drop-in helper for servers that already own a tool registry and an
// `McpServer` instance. Decorates each tool's input schema with the telemetry
// block, strips telemetry from args before invoking the original handler, and
// emits analytics batches — without monkey-patching `McpServer.prototype`. The
// caller passes us the concrete server they constructed, so under pnpm
// virtual-peer layouts we register on the same SDK class instance the app
// already holds.

// Overload 1: registry entries are already `InstrumentedTool`-shaped — `mapTool`
// is genuinely optional.
export function instrumentMcpServerTools(
  options: BaseInstrumentOptions & {
    tools: InstrumentedTool[] | Record<string, InstrumentedTool>;
    mapTool?: (def: InstrumentedTool, key?: string) => InstrumentedTool;
  },
): InstrumentMcpServerToolsResult;
// Overload 2: arbitrary registry shape — `mapTool` is required so we never
// silently identity-cast custom entries into `InstrumentedTool`.
export function instrumentMcpServerTools<TDef>(
  options: BaseInstrumentOptions & {
    tools: TDef[] | Record<string, TDef>;
    mapTool: (def: TDef, key?: string) => InstrumentedTool;
  },
): InstrumentMcpServerToolsResult;
export function instrumentMcpServerTools<TDef>(
  options: InstrumentMcpServerToolsOptions<TDef>,
): InstrumentMcpServerToolsResult {
  const recorder = createAnalyticsRecorder(options.config);
  recorder.attachToMcpServer(options.server);

  const identity = (def: TDef): InstrumentedTool =>
    def as unknown as InstrumentedTool;
  const mapper = options.mapTool ?? identity;

  if (Array.isArray(options.tools)) {
    for (const def of options.tools) {
      const mapped = mapper(def, undefined);
      recorder.tool(mapped, mapped.handler);
    }
  } else {
    for (const [key, def] of Object.entries(options.tools)) {
      const mapped = mapper(def, key);
      recorder.tool(mapped, mapped.handler);
    }
  }

  return { server: options.server, recorder };
}
