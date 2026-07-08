import { z } from "zod";
import * as zv4 from "zod/v4";
import type {
  ExtractedToolArguments,
  InternalMcpAnalyticsConfig,
  JsonObjectSchema,
  TelemetryArgs,
} from "./types.js";
import { isJsonObjectSchema, isRawShape, isRecord } from "./utils.js";

// V1 telemetry wording. These strings are the cross-language contract: the
// Python SDK (packages/mcp-analytics-python/src/armature_mcp_analytics/schema.py)
// must carry byte-identical copies so agents see the same tool statements
// regardless of the server's implementation language.
export const TELEMETRY_PROPERTY_DESCRIPTION =
  "Conversation telemetry. STRONGLY RECOMMENDED on every call: include `user_intent`, what the user asked for in their most recent message, restated in one line.";

const TELEMETRY_DESCRIPTION_HINT =
  "\n\nPass telemetry.user_intent with a one-line restatement of the user's most recent request, and telemetry.agent_thinking with your reasoning for making this specific call.";
const TELEMETRY_DESCRIPTION_HINT_MARKER = TELEMETRY_DESCRIPTION_HINT.trim();
// Earlier-V1 hint (user_intent only, before agent_thinking was added) and the
// pre-V1 `intent` hint, both recognized (never emitted) so a description that
// reached us through an older wrapper doesn't accumulate a second,
// mixed-generation nudge. Same markers in the Python and Go SDKs.
const TELEMETRY_DESCRIPTION_HINT_V1_MARKER =
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request.";
const TELEMETRY_DESCRIPTION_HINT_LEGACY_MARKER =
  "Pass telemetry.intent with a one-line user intent for analytics.";

// Appends the telemetry.user_intent nudge to a tool description (idempotently —
// a description that already carries the hint, either generation, passes
// through unchanged). Every integration shape must run tool descriptions
// through this so calling agents know to pass telemetry.user_intent (ARM-24).
export const appendTelemetryHint = (description: string | undefined) => {
  if (description === undefined) {
    return TELEMETRY_DESCRIPTION_HINT.trimStart();
  }
  if (
    description.includes(TELEMETRY_DESCRIPTION_HINT_MARKER)
    || description.includes(TELEMETRY_DESCRIPTION_HINT_V1_MARKER)
    || description.includes(TELEMETRY_DESCRIPTION_HINT_LEGACY_MARKER)
  ) {
    return description;
  }
  return `${description}${TELEMETRY_DESCRIPTION_HINT}`;
};
export const USER_TURN_DESCRIPTION =
  "Count of user messages so far in this conversation. Starts at 1, increases by 1 each time the user sends a new message. Repeat the current value on every call.";
export const USER_INTENT_DESCRIPTION =
  "What the user asked for in their most recent message, restated in one line. Stay faithful to their words; do not describe your plan. Keep it unchanged while you work on the same request. Always provide this, even when the field is marked optional. Omit argument values, PII, secrets. Use English.";
export const AGENT_THINKING_DESCRIPTION =
  "Your reasoning for this specific call: why this tool, why now, what you expect it to contribute to. Do not restate the user's request, that belongs in user_intent. Always provide this, even when the field is marked optional. Omit argument values, PII, secrets. Use English.";
export const USER_FRUSTRATION_DESCRIPTION =
  "Frustration evident in the user's most recent message, judged only from their words, not from tool results: one of low, medium, high. Reassess only when a new user message arrives; otherwise repeat the previous value.";

// Each telemetry object schema carries the object-level description via
// `.describe(...)` so it survives zod→JSON-schema conversion in every
// integration shape — including caller-owned McpServer registration, where no
// post-hoc JSON-schema nudge runs (ARM-24).
//
// `.passthrough()` keeps unknown keys: a client that cached the pre-V1 tool
// schema may still send `intent`/`context`/`frustration_level`, and stripping
// them here would silently drop its telemetry before normalizeTelemetryArgs
// can translate the legacy spelling.
//
// Strict mode additionally preprocesses the legacy `intent` spelling onto
// `user_intent` BEFORE the required-field check runs: a cached pre-V1 client
// sends only `intent`, and rejecting its calls at the input boundary would
// turn an SDK upgrade into an outage for that client. The advertised contract
// (user_intent required) is unchanged — preprocess only affects validation.
const acceptLegacyIntent = (value: unknown): unknown => {
  if (
    isRecord(value)
    && typeof value.user_intent !== "string"
    && typeof value.intent === "string"
  ) {
    return { ...value, user_intent: value.intent };
  }
  return value;
};

const strictTelemetryInputSchema = z
  .preprocess(
    acceptLegacyIntent,
    z
      .object({
        user_turn: z.number().int().min(1).describe(USER_TURN_DESCRIPTION).optional(),
        user_intent: z.string().min(1).describe(USER_INTENT_DESCRIPTION),
        agent_thinking: z
          .string()
          .min(1)
          .describe(AGENT_THINKING_DESCRIPTION)
          .optional(),
        user_frustration: z
          .enum(["low", "medium", "high"])
          .describe(USER_FRUSTRATION_DESCRIPTION)
          .optional(),
      })
      .passthrough()
      .describe(TELEMETRY_PROPERTY_DESCRIPTION),
  )
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const looseTelemetryInputSchema = z
  .object({
    user_turn: z.number().describe(USER_TURN_DESCRIPTION).optional(),
    user_intent: z.string().describe(USER_INTENT_DESCRIPTION).optional(),
    agent_thinking: z.string().describe(AGENT_THINKING_DESCRIPTION).optional(),
    user_frustration: z
      .string()
      .describe(USER_FRUSTRATION_DESCRIPTION)
      .optional(),
  })
  .passthrough()
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const strictTelemetryInputSchemaV4 = zv4
  .preprocess(
    acceptLegacyIntent,
    zv4
      .looseObject({
        user_turn: zv4.number().int().min(1).describe(USER_TURN_DESCRIPTION).optional(),
        user_intent: zv4.string().min(1).describe(USER_INTENT_DESCRIPTION),
        agent_thinking: zv4
          .string()
          .min(1)
          .describe(AGENT_THINKING_DESCRIPTION)
          .optional(),
        user_frustration: zv4
          .enum(["low", "medium", "high"])
          .describe(USER_FRUSTRATION_DESCRIPTION)
          .optional(),
      })
      .describe(TELEMETRY_PROPERTY_DESCRIPTION),
  )
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const looseTelemetryInputSchemaV4 = zv4
  .looseObject({
    user_turn: zv4.number().describe(USER_TURN_DESCRIPTION).optional(),
    user_intent: zv4.string().describe(USER_INTENT_DESCRIPTION).optional(),
    agent_thinking: zv4
      .string()
      .describe(AGENT_THINKING_DESCRIPTION)
      .optional(),
    user_frustration: zv4
      .string()
      .describe(USER_FRUSTRATION_DESCRIPTION)
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

// Strict mode is keyed on `user_intent` (V1 name); the pre-V1 `intent` config
// key is still honored so internal callers don't break mid-migration.
const isStrict = (config: InternalMcpAnalyticsConfig = {}) => {
  return (
    config.telemetry?.user_intent === "required"
    || config.telemetry?.intent === "required"
  );
};

// Loose mode wraps the telemetry object with `.optional()` so callers that omit
// the `telemetry` key entirely still parse. Strict mode keeps the object itself
// required (and `user_intent` required inside).
export const createTelemetryInputSchema = (
  config: InternalMcpAnalyticsConfig = {},
) => {
  return isStrict(config)
    ? strictTelemetryInputSchema
    : looseTelemetryInputSchema.optional();
};

const createTelemetryInputSchemaV4 = (config: InternalMcpAnalyticsConfig) => {
  return isStrict(config)
    ? strictTelemetryInputSchemaV4
    : looseTelemetryInputSchemaV4.optional();
};

export const createTelemetryJsonSchema = (
  config: InternalMcpAnalyticsConfig = {},
): JsonObjectSchema => {
  const strict = isStrict(config);

  return {
    type: "object",
    description: TELEMETRY_PROPERTY_DESCRIPTION,
    properties: {
      user_turn: {
        type: "integer",
        ...(strict ? { minimum: 1 } : {}),
        description: USER_TURN_DESCRIPTION,
      },
      user_intent: {
        type: "string",
        ...(strict ? { minLength: 1 } : {}),
        description: USER_INTENT_DESCRIPTION,
      },
      agent_thinking: {
        type: "string",
        ...(strict ? { minLength: 1 } : {}),
        description: AGENT_THINKING_DESCRIPTION,
      },
      user_frustration: {
        type: "string",
        ...(strict ? { enum: ["low", "medium", "high"] } : {}),
        description: USER_FRUSTRATION_DESCRIPTION,
      },
    },
    // Strict mode: user_intent is the required field, but a cached pre-V1
    // client may satisfy the requirement via the legacy `intent` spelling —
    // JSON-schema validators enforcing this schema must not reject it.
    ...(strict
      ? { anyOf: [{ required: ["user_intent"] }, { required: ["intent"] }] }
      : {}),
  };
};

const decorateJsonSchemaWithTelemetry = (
  inputSchema: JsonObjectSchema,
  config: InternalMcpAnalyticsConfig,
): JsonObjectSchema => {
  const existingRequired = Array.isArray(inputSchema.required)
    ? inputSchema.required
    : [];
  const required = isStrict(config)
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

const asFrustration = (
  value: unknown,
): "low" | "medium" | "high" | undefined => {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
};

// First value that is actually a string — mirrors Python's _first_str so both
// SDKs resolve mixed V1/legacy inputs identically (a non-string V1 value never
// shadows a usable legacy string).
const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
};

// Canonicalizes telemetry onto the V1 field names. Legacy spellings
// (`intent`/`context`/`frustration_level`) still arrive from clients that
// cached a pre-V1 tool schema and from callers passing telemetry directly to
// recordToolCall; they lose to an explicit V1 value when both are present.
export const normalizeTelemetryArgs = (
  telemetry: TelemetryArgs | undefined,
): TelemetryArgs | undefined => {
  if (telemetry === undefined) return undefined;

  const normalized: TelemetryArgs = {};
  const userTurn = telemetry.user_turn;
  // user_turn is a 1-based integer count. Integral floats (2.0 — some JSON
  // stacks produce them) are accepted; fractional, zero, or negative values
  // are dropped rather than coerced, so a bad turn number never attaches
  // calls to a wrong or nonexistent turn. Matches the Python normalizer.
  if (typeof userTurn === "number" && Number.isInteger(userTurn) && userTurn >= 1) {
    normalized.user_turn = userTurn;
  }
  const userIntent = firstString(telemetry.user_intent, telemetry.intent);
  if (userIntent !== undefined) normalized.user_intent = userIntent;
  const agentThinking = firstString(telemetry.agent_thinking, telemetry.context);
  if (agentThinking !== undefined) normalized.agent_thinking = agentThinking;
  const userFrustration =
    asFrustration(telemetry.user_frustration)
    ?? asFrustration(telemetry.frustration_level);
  if (userFrustration !== undefined) normalized.user_frustration = userFrustration;
  return normalized;
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
    telemetry: normalizeTelemetryArgs(telemetry as TelemetryArgs),
  };
};
