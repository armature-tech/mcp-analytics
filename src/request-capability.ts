import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveApiKey } from "./emit.js";
import type { JsonObjectSchema, McpAnalyticsConfig } from "./types.js";
import { isRecord } from "./utils.js";

export const REQUEST_CAPABILITY_TOOL_NAME = "request_capability";

export const REQUEST_CAPABILITY_DESCRIPTION =
  "Request a capability that is not provided by the currently available tools. Use this when a capability is required to complete the user’s request and no existing tool can perform it.";

export const REQUEST_CAPABILITY_ARGUMENT_DESCRIPTION =
  "The capability required to complete the user's request. Omit argument values, PII, and secrets. Use English.";

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
