import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveApiKey } from "./emit.js";
import type { JsonObjectSchema, McpAnalyticsConfig } from "./types.js";
import { isRecord } from "./utils.js";

// The SDK-owned feedback tool. Named send_feedback, like PostHog's; releases
// before the connector-directory change named it request_capability, a name
// ingest and the doctor still recognize. The REQUEST_CAPABILITY_* identifiers
// keep their names so existing imports compile.
export const SEND_FEEDBACK_TOOL_NAME = "send_feedback";
export const LEGACY_REQUEST_CAPABILITY_TOOL_NAME = "request_capability";
export const REQUEST_CAPABILITY_TOOL_NAME = SEND_FEEDBACK_TOOL_NAME;

export const REQUEST_CAPABILITY_DESCRIPTION =
  "Records that the user asked for something these tools cannot do, so the developers of this server can add it. It changes no data and contacts no one. Call it whenever you cannot do what the user asked with these tools, including when you send them to an app, a website or a manual step instead. Then answer them as usual.";

export const REQUEST_CAPABILITY_ARGUMENT_DESCRIPTION =
  "One English sentence describing the missing capability needed for the user's task. Translate the summary into English even when the user writes in another language. Describe generic actions and roles. Omit names, contacts, IDs, credentials and all tool argument values.";

export const REQUEST_CAPABILITY_INPUT_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    capability: {
      type: "string",
      description: REQUEST_CAPABILITY_ARGUMENT_DESCRIPTION,
      minLength: 1,
      maxLength: 1000,
    },
  },
  required: ["capability"],
  additionalProperties: false,
};

// Directories such as ChatGPT's reject tools without explicit readOnlyHint,
// destructiveHint and openWorldHint. The tool records an analytics event (not
// read-only), changes no user data and reaches no one outside the server.
// Matches the hosted Armature MCP (lib/mcp/index.js).
export const REQUEST_CAPABILITY_ANNOTATIONS = {
  title: "Send feedback",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

// McpServer.registerTool accepts a Zod raw shape, while custom dispatchers
// consume the JSON Schema above from recorder.toolDefinitions().
export const REQUEST_CAPABILITY_ZOD_SHAPE = {
  capability: z
    .string()
    .min(1)
    .max(1000)
    .describe(REQUEST_CAPABILITY_ARGUMENT_DESCRIPTION),
};

// armature.sendFeedback, or the earlier armature.requestCapability; the new
// key wins when both are set. Undefined means the default.
const sendFeedbackSetting = (config: McpAnalyticsConfig) =>
  config.armature?.sendFeedback ?? config.armature?.requestCapability;

// On by default when a delivery path is configured; `sendFeedback: false`
// disables it. No other tool description mentions it.
export const isRequestCapabilityEnabled = (config: McpAnalyticsConfig) =>
  sendFeedbackSetting(config) !== false
  && config.armature?.enabled !== false
  && (typeof config.armature?.emit === "function" || Boolean(resolveApiKey(config)));

// True only when the caller explicitly opted in. The reserved-name and
// server-shape guards key off this stricter check, so a server that is on
// merely by default skips injection quietly on a collision or an
// incompatible factory result instead of breaking on upgrade.
export const isRequestCapabilityExplicit = (config: McpAnalyticsConfig) =>
  sendFeedbackSetting(config) === true;

export const handleRequestCapability = (args: unknown): CallToolResult => {
  if (
    !isRecord(args)
    || typeof args.capability !== "string"
    || args.capability.trim().length === 0
    || args.capability.length > 1000
  ) {
    return {
      isError: true,
      content: [{ type: "text", text: "capability must be a non-empty string" }],
    };
  }

  return {
    content: [{ type: "text", text: "Capability request acknowledged." }],
  };
};
