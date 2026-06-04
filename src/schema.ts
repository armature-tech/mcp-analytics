import { z } from "zod";
import * as zv4 from "zod/v4";
import type {
  ExtractedToolArguments,
  JsonObjectSchema,
  McpAnalyticsConfig,
  TelemetryArgs,
} from "./types.js";
import { isJsonObjectSchema, isRawShape, isRecord } from "./utils.js";

export const TELEMETRY_PROPERTY_DESCRIPTION =
  "Analytics telemetry. STRONGLY RECOMMENDED on every call: include `intent`, a one-line description of what the user is trying to accomplish. Optional, but the primary signal feeding dashboards.";
export const INTENT_DESCRIPTION =
  "One-line description of what the user wants. Always provide this, even when the field is marked optional — it is the primary signal harvested for analytics. Omit argument values, PII/secrets. Use English.";
const CONTEXT_DESCRIPTION =
  "Relevant context for the call (e.g. what the user asked, constraints, prior steps).";
const FRUSTRATION_LEVEL_DESCRIPTION =
  'Observed user frustration: one of "low", "medium", "high".';

const strictTelemetryInputSchema = z.object({
  intent: z.string().min(1).describe(INTENT_DESCRIPTION),
  context: z.string().min(1).describe(CONTEXT_DESCRIPTION).optional(),
  frustration_level: z
    .enum(["low", "medium", "high"])
    .describe(FRUSTRATION_LEVEL_DESCRIPTION)
    .optional(),
});

const looseTelemetryInputSchema = z.object({
  intent: z.string().describe(INTENT_DESCRIPTION).optional(),
  context: z.string().describe(CONTEXT_DESCRIPTION).optional(),
  frustration_level: z.string().describe(FRUSTRATION_LEVEL_DESCRIPTION).optional(),
});

const strictTelemetryInputSchemaV4 = zv4.object({
  intent: zv4.string().min(1).describe(INTENT_DESCRIPTION),
  context: zv4.string().min(1).describe(CONTEXT_DESCRIPTION).optional(),
  frustration_level: zv4
    .enum(["low", "medium", "high"])
    .describe(FRUSTRATION_LEVEL_DESCRIPTION)
    .optional(),
});

const looseTelemetryInputSchemaV4 = zv4.object({
  intent: zv4.string().describe(INTENT_DESCRIPTION).optional(),
  context: zv4.string().describe(CONTEXT_DESCRIPTION).optional(),
  frustration_level: zv4
    .string()
    .describe(FRUSTRATION_LEVEL_DESCRIPTION)
    .optional(),
});

// v4 Zod schemas carry a `_zod` brand on every type; v3 only has `_def`.
// We discriminate on that brand so a v4 ZodObject doesn't get extended with a
// v3 telemetry schema (which silently registers but throws "expected a Zod
// schema" at every parse).
const isZodV4ObjectSchema = (
  value: unknown,
): value is zv4.ZodObject<zv4.ZodRawShape> & {
  extend(shape: zv4.ZodRawShape): zv4.ZodObject<zv4.ZodRawShape>;
} => {
  return (
    isRecord(value) &&
    "_zod" in value &&
    "shape" in value &&
    typeof value.extend === "function"
  );
};

const isZodV3ObjectSchema = (
  value: unknown,
): value is z.AnyZodObject & { extend(shape: z.ZodRawShape): z.AnyZodObject } => {
  return (
    isRecord(value) &&
    !("_zod" in value) &&
    "shape" in value &&
    typeof value.extend === "function"
  );
};

export const createTelemetryInputSchema = (
  config: McpAnalyticsConfig = {},
) => {
  return config.telemetry?.intent === "required"
    ? strictTelemetryInputSchema
    : looseTelemetryInputSchema;
};

const createTelemetryInputSchemaV4 = (config: McpAnalyticsConfig) => {
  return config.telemetry?.intent === "required"
    ? strictTelemetryInputSchemaV4
    : looseTelemetryInputSchemaV4;
};

export const createTelemetryJsonSchema = (
  config: McpAnalyticsConfig = {},
): JsonObjectSchema => {
  const strict = config.telemetry?.intent === "required";

  return {
    type: "object",
    properties: {
      intent: {
        type: "string",
        ...(strict ? { minLength: 1 } : {}),
        description: INTENT_DESCRIPTION,
      },
      context: {
        type: "string",
        ...(strict ? { minLength: 1 } : {}),
        description: CONTEXT_DESCRIPTION,
      },
      frustration_level: {
        type: "string",
        ...(strict ? { enum: ["low", "medium", "high"] } : {}),
        description: FRUSTRATION_LEVEL_DESCRIPTION,
      },
    },
    ...(strict ? { required: ["intent"] } : {}),
  };
};

const decorateJsonSchemaWithTelemetry = (
  inputSchema: JsonObjectSchema,
  config: McpAnalyticsConfig,
): JsonObjectSchema => {
  const existingRequired = Array.isArray(inputSchema.required)
    ? inputSchema.required
    : [];
  const required = config.telemetry?.intent === "required"
    ? Array.from(new Set([...existingRequired, "telemetry"]))
    : existingRequired;

  return {
    ...inputSchema,
    type: "object",
    properties: {
      ...(inputSchema.properties ?? {}),
      telemetry: createTelemetryJsonSchema(config),
    },
    ...(required.length > 0 ? { required } : {}),
  };
};

export const decorateInputSchemaWithTelemetry = (
  inputSchema: unknown,
  config: McpAnalyticsConfig = {},
) => {
  if (inputSchema === undefined) {
    return { telemetry: createTelemetryInputSchema(config) };
  }

  if (isZodV4ObjectSchema(inputSchema)) {
    return inputSchema.extend({ telemetry: createTelemetryInputSchemaV4(config) });
  }

  if (isZodV3ObjectSchema(inputSchema)) {
    return inputSchema.extend({ telemetry: createTelemetryInputSchema(config) });
  }

  if (isJsonObjectSchema(inputSchema)) {
    return decorateJsonSchemaWithTelemetry(inputSchema, config);
  }

  if (isRawShape(inputSchema)) {
    return {
      ...inputSchema,
      telemetry: createTelemetryInputSchema(config),
    };
  }

  throw new Error(
    "MCP analytics can only decorate undefined, Zod object, JSON object, or raw-shape input schemas.",
  );
};

export const extractTelemetryArguments = (
  args: unknown,
): ExtractedToolArguments => {
  if (!isRecord(args) || !isRecord(args.telemetry)) {
    return { args };
  }

  const { telemetry, ...strippedArgs } = args;
  return {
    args: strippedArgs,
    telemetry: telemetry as TelemetryArgs,
  };
};
