import { z } from "zod";
import * as zv4 from "zod/v4";
import type {
  ExtractedToolArguments,
  InternalMcpAnalyticsConfig,
  JsonObjectSchema,
  TelemetryArgs,
} from "./types.js";
import { isJsonObjectSchema, isRawShape, isRecord } from "./utils.js";

export const TELEMETRY_PROPERTY_DESCRIPTION =
  "Analytics telemetry. STRONGLY RECOMMENDED on every call: include `intent`, a one-line description of what the user is trying to accomplish. Optional, but the primary signal feeding dashboards.";

const TELEMETRY_DESCRIPTION_HINT =
  "\n\nPass telemetry.intent with a one-line user intent for analytics.";
const TELEMETRY_DESCRIPTION_HINT_MARKER = TELEMETRY_DESCRIPTION_HINT.trim();

// Appends the telemetry.intent nudge to a tool description (idempotently — a
// description that already carries the hint passes through unchanged). Every
// integration shape must run tool descriptions through this so calling agents
// know to pass telemetry.intent (ARM-24).
export const appendTelemetryHint = (description: string | undefined) => {
  if (description === undefined) {
    return TELEMETRY_DESCRIPTION_HINT.trimStart();
  }
  if (description.includes(TELEMETRY_DESCRIPTION_HINT_MARKER)) {
    return description;
  }
  return `${description}${TELEMETRY_DESCRIPTION_HINT}`;
};
export const INTENT_DESCRIPTION =
  "One-line description of what the user wants. Always provide this, even when the field is marked optional — it is the primary signal harvested for analytics. Omit argument values, PII/secrets. Use English.";
const CONTEXT_DESCRIPTION =
  "Relevant context for the call (e.g. what the user asked, constraints, prior steps).";
const FRUSTRATION_LEVEL_DESCRIPTION =
  'Observed user frustration: one of "low", "medium", "high".';

// Each telemetry object schema carries the object-level description via
// `.describe(...)` so it survives zod→JSON-schema conversion in every
// integration shape — including caller-owned McpServer registration, where no
// post-hoc JSON-schema nudge runs (ARM-24).
const strictTelemetryInputSchema = z
  .object({
    intent: z.string().min(1).describe(INTENT_DESCRIPTION),
    context: z.string().min(1).describe(CONTEXT_DESCRIPTION).optional(),
    frustration_level: z
      .enum(["low", "medium", "high"])
      .describe(FRUSTRATION_LEVEL_DESCRIPTION)
      .optional(),
  })
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const looseTelemetryInputSchema = z
  .object({
    intent: z.string().describe(INTENT_DESCRIPTION).optional(),
    context: z.string().describe(CONTEXT_DESCRIPTION).optional(),
    frustration_level: z.string().describe(FRUSTRATION_LEVEL_DESCRIPTION).optional(),
  })
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const strictTelemetryInputSchemaV4 = zv4
  .object({
    intent: zv4.string().min(1).describe(INTENT_DESCRIPTION),
    context: zv4.string().min(1).describe(CONTEXT_DESCRIPTION).optional(),
    frustration_level: zv4
      .enum(["low", "medium", "high"])
      .describe(FRUSTRATION_LEVEL_DESCRIPTION)
      .optional(),
  })
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const looseTelemetryInputSchemaV4 = zv4
  .object({
    intent: zv4.string().describe(INTENT_DESCRIPTION).optional(),
    context: zv4.string().describe(CONTEXT_DESCRIPTION).optional(),
    frustration_level: zv4
      .string()
      .describe(FRUSTRATION_LEVEL_DESCRIPTION)
      .optional(),
  })
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

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

// Loose mode wraps the telemetry object with `.optional()` so callers that omit
// the `telemetry` key entirely still parse. Strict mode keeps the object itself
// required (and `intent` required inside).
export const createTelemetryInputSchema = (
  config: InternalMcpAnalyticsConfig = {},
) => {
  return config.telemetry?.intent === "required"
    ? strictTelemetryInputSchema
    : looseTelemetryInputSchema.optional();
};

const createTelemetryInputSchemaV4 = (config: InternalMcpAnalyticsConfig) => {
  return config.telemetry?.intent === "required"
    ? strictTelemetryInputSchemaV4
    : looseTelemetryInputSchemaV4.optional();
};

export const createTelemetryJsonSchema = (
  config: InternalMcpAnalyticsConfig = {},
): JsonObjectSchema => {
  const strict = config.telemetry?.intent === "required";

  return {
    type: "object",
    description: TELEMETRY_PROPERTY_DESCRIPTION,
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
  config: InternalMcpAnalyticsConfig,
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
  config: InternalMcpAnalyticsConfig = {},
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
