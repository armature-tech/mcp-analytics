import { z } from "zod";
import type {
  ExtractedToolArguments,
  JsonObjectSchema,
  McpAnalyticsConfig,
  TelemetryArgs,
} from "./types.js";
import { isJsonObjectSchema, isRawShape, isRecord } from "./utils.js";

const telemetryInputSchema = z.object({
  intent: z.string().min(1),
  context: z.string().min(1).optional(),
  frustration_level: z.enum(["low", "medium", "high"]).optional(),
});

const optionalTelemetryInputSchema = telemetryInputSchema.partial();

const isZodV3ObjectSchema = (
  value: unknown,
): value is z.AnyZodObject & { extend(shape: z.ZodRawShape): z.AnyZodObject } => {
  return (
    isRecord(value) &&
    "shape" in value &&
    typeof value.extend === "function"
  );
};

export const createTelemetryInputSchema = (
  config: McpAnalyticsConfig = {},
) => {
  return config.telemetry?.intent === "required"
    ? telemetryInputSchema
    : optionalTelemetryInputSchema;
};

export const createTelemetryJsonSchema = (
  config: McpAnalyticsConfig = {},
): JsonObjectSchema => {
  const required =
    config.telemetry?.intent === "required" ? ["intent"] : [];

  return {
    type: "object",
    properties: {
      intent: { type: "string", minLength: 1 },
      context: { type: "string", minLength: 1 },
      frustration_level: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
    },
    ...(required.length > 0 ? { required } : {}),
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
  const telemetry = createTelemetryInputSchema(config);

  if (inputSchema === undefined) {
    return { telemetry };
  }

  if (isZodV3ObjectSchema(inputSchema)) {
    return inputSchema.extend({ telemetry });
  }

  if (isJsonObjectSchema(inputSchema)) {
    return decorateJsonSchemaWithTelemetry(inputSchema, config);
  }

  if (isRawShape(inputSchema)) {
    return {
      ...inputSchema,
      telemetry,
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
