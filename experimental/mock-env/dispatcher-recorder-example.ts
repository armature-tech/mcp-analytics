import { createAnalyticsRecorder } from "../../src/index.js";

type RequestContext = {
  organizationId: string;
  userProfileId: string;
  role: "admin" | "member";
};

type LookupCustomerArgs = {
  customer_id: string;
};

const analytics = createAnalyticsRecorder({
  armature: {
    mcpServerId: "mock-dispatcher",
    actorId: ({ ctx }) => (ctx as RequestContext).userProfileId,
    delivery: "await",
  },
});

analytics.tool<LookupCustomerArgs>(
  {
    name: "lookup_customer",
    description: "Look up a customer by id.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
      },
      required: ["customer_id"],
    },
  },
  async (args, { ctx }) => {
    const requestCtx = ctx as RequestContext;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            args,
            organizationId: requestCtx.organizationId,
          }),
        },
      ],
    };
  },
);

export const listTools = () => analytics.toolDefinitions();

export const callTool = (
  name: string,
  rawArgs: unknown,
  ctx: RequestContext,
) => analytics.dispatch(name, rawArgs, { ctx });
