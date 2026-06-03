import {
  createAnalyticsRecorder,
  type AnalyticsRecorder,
  type McpAnalyticsConfig,
  type ToolDefinition,
} from "../../src/index.js";

export type DispatcherRequestContext = {
  sessionId: string;
  organizationId: string;
  userProfileId: string;
};

export type DemoCustomerLookupArgs = {
  customer: string;
};

const buildCustomerNote = ({ customer }: DemoCustomerLookupArgs) => {
  const normalized = customer.trim();
  const note = normalized.toLowerCase().includes("folk")
    ? "Folk account note: interested in lightweight MCP analytics demos."
    : `${normalized} account note: no live CRM lookup was performed.`;
  return { normalized, note };
};

export type CreateDispatcherDemoOptions = {
  config?: McpAnalyticsConfig;
};

export type DispatcherDemo = {
  listTools: () => ToolDefinition[];
  callTool: (
    name: string,
    rawArgs: unknown,
    ctx: DispatcherRequestContext,
  ) => Promise<unknown>;
  recordSessionInit: (ctx: DispatcherRequestContext) => Promise<void>;
  recorder: AnalyticsRecorder;
};

export const createDispatcherDemo = (
  options: CreateDispatcherDemoOptions = {},
): DispatcherDemo => {
  const recorder = createAnalyticsRecorder({
    telemetry: options.config?.telemetry,
    armature: {
      delivery: "await",
      timeoutMs: 15_000,
      actorId: ({ ctx }) => (ctx as DispatcherRequestContext).userProfileId,
      onError(error) {
        console.error("Failed to emit dispatcher analytics", error);
      },
      ...(options.config?.armature ?? {}),
    },
  });

  recorder.tool<DemoCustomerLookupArgs>(
    {
      name: "lookup_customer_note",
      description:
        "Return a tiny hardcoded customer note for dispatcher smoke tests.",
      inputSchema: {
        type: "object",
        properties: {
          customer: {
            type: "string",
            minLength: 1,
            description: "Customer name or account label.",
          },
        },
        required: ["customer"],
      },
    },
    async (args) => {
      if (typeof args?.customer !== "string" || args.customer.trim().length === 0) {
        throw new Error("`customer` is required");
      }
      const { normalized, note } = buildCustomerNote(args);
      return {
        content: [{ type: "text" as const, text: note }],
        structuredContent: {
          customer: normalized,
          note,
          source: "hardcoded-demo-dispatcher",
        },
      };
    },
  );

  return {
    listTools: () => recorder.toolDefinitions(),
    recordSessionInit: (ctx) =>
      recorder.recordSessionInit({ ctx, sessionId: ctx.sessionId }),
    callTool: (name, rawArgs, ctx) =>
      recorder.dispatch(name, rawArgs, { ctx, sessionId: ctx.sessionId }),
    recorder,
  };
};
