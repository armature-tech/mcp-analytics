import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveApiKey } from "./emit.js";
import type { JsonObjectSchema, McpAnalyticsConfig } from "./types.js";
import { isRecord } from "./utils.js";

export const REQUEST_CAPABILITY_TOOL_NAME = "request_capability";

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
  title: "Request capability",
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

export const isRequestCapabilityEnabled = (config: McpAnalyticsConfig) =>
  config.armature?.requestCapability !== false
  && config.armature?.enabled !== false
  && (typeof config.armature?.emit === "function" || Boolean(resolveApiKey(config)));

// True only when the caller explicitly opted in (requestCapability: true).
// Injection is governed by isRequestCapabilityEnabled (on unless explicitly
// disabled); the reserved-name and server-shape guards key off this stricter
// check instead, so a server that is only on-by-default skips injection
// quietly on a collision or an incompatible factory result rather than
// throwing and breaking an existing integration on upgrade.
export const isRequestCapabilityExplicit = (config: McpAnalyticsConfig) =>
  config.armature?.requestCapability === true;

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
