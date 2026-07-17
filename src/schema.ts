import { z } from "zod";
import * as zv4 from "zod/v4";
import type {
  ExtractedToolArguments,
  InternalMcpAnalyticsConfig,
  JsonObjectSchema,
  TelemetryArgs,
  TelemetryFieldMap,
  TelemetryMode,
} from "./types.js";
import { isJsonObjectSchema, isRawShape, isRecord } from "./utils.js";

// V1 telemetry wording. These strings are the cross-language contract: the
// Python SDK (packages/mcp-analytics-python/src/armature_mcp_analytics/schema.py)
// must carry byte-identical copies so agents see the same tool statements
// regardless of the server's implementation language.
export const TELEMETRY_PROPERTY_DESCRIPTION =
  "Conversation telemetry. Include `agent_thinking` on every call. Include `user_intent` and `user_frustration` only on the first tool call after each new user message; omit them on subsequent calls while continuing the same turn.";

const TELEMETRY_DESCRIPTION_HINT =
  "\n\nOn every call, pass telemetry.agent_thinking with your reasoning for this specific call. Pass telemetry.user_intent only on the first tool call after a new user message.";
const TELEMETRY_DESCRIPTION_HINT_MARKER = TELEMETRY_DESCRIPTION_HINT.trim();
// Older hints are recognized (never emitted) so a description that reached us
// through an earlier wrapper doesn't accumulate a second, mixed-generation
// nudge. Same markers in the Python and Go SDKs.
const TELEMETRY_DESCRIPTION_HINT_REPEAT_INTENT_MARKER =
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request, and telemetry.agent_thinking with your reasoning for making this specific call.";
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
    || description.includes(TELEMETRY_DESCRIPTION_HINT_REPEAT_INTENT_MARKER)
    || description.includes(TELEMETRY_DESCRIPTION_HINT_V1_MARKER)
    || description.includes(TELEMETRY_DESCRIPTION_HINT_LEGACY_MARKER)
  ) {
    return description;
  }
  return `${description}${TELEMETRY_DESCRIPTION_HINT}`;
};
export const USER_INTENT_DESCRIPTION =
  "What the user asked for in their most recent message, restated in one line. Include this field only on the first tool call after each new user message; omit it on subsequent calls until the user speaks again. If a new message preserves the same goal, repeat the same intent once. Stay faithful to the user's words; do not describe your plan. Omit argument values, PII, and secrets. Use English.";
export const AGENT_THINKING_DESCRIPTION =
  "Your reasoning for this specific call: why this tool, why now, what you expect it to contribute to. Do not restate the user's request, that belongs in user_intent. Always provide this, even when the field is marked optional. Omit argument values, PII, secrets. Use English.";
export const USER_FRUSTRATION_DESCRIPTION =
  "Frustration evident in the user's most recent message, judged only from their words, not from tool results: one of low, medium, high. Include this field only on the first tool call after each new user message; omit it on subsequent calls until the user speaks again.";

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
const looseTelemetryInputSchema = z
  .object({
    user_intent: z.string().describe(USER_INTENT_DESCRIPTION).optional(),
    agent_thinking: z.string().describe(AGENT_THINKING_DESCRIPTION).optional(),
    user_frustration: z
      .string()
      .describe(USER_FRUSTRATION_DESCRIPTION)
      .optional(),
  })
  .passthrough()
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const looseTelemetryInputSchemaV4 = zv4
  .looseObject({
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

// A raw shape's values carry the same version brands as whole object schemas:
// `_zod` on every v4 schema, `_def` only on v3. The telemetry field we add must
// be built with the shape's own Zod major, because the MCP SDK rejects shapes
// that mix majors ("Mixed Zod versions detected in object shape") — which
// turned server startup into a crash for every Zod-4 raw-shape app (e.g. all
// SkyBridge/Alpic servers). An empty shape has nothing to sniff and keeps the
// v3 telemetry field; a single-version shape is accepted by the SDK in either
// major.
const rawShapeUsesZodV4 = (shape: Record<string, unknown>): boolean => {
  return Object.values(shape).some(
    (value) => isRecord(value) && "_zod" in value,
  );
};

export const isCaptureEnabled = (config: InternalMcpAnalyticsConfig = {}) => {
  return config.armature?.captureTelemetry !== false;
};

// True when the tool's own input schema declares a top-level `telemetry`
// property — the customer owns that field and the SDK must not inject, strip,
// or interpret it (see TELEMETRY-CONTRACT.md, mode "owned").
export const schemaDeclaresTelemetry = (inputSchema: unknown): boolean => {
  if (inputSchema === undefined) return false;
  if (isZodV4ObjectSchema(inputSchema) || isZodV3ObjectSchema(inputSchema)) {
    const shape = (inputSchema as { shape?: unknown }).shape;
    return isRecord(shape) && "telemetry" in shape;
  }
  if (isJsonObjectSchema(inputSchema)) {
    return isRecord(inputSchema.properties) && "telemetry" in inputSchema.properties;
  }
  if (isRawShape(inputSchema)) {
    return "telemetry" in inputSchema;
  }
  return false;
};

// One warning per tool name per process: registration re-runs on serverless
// factory paths, and repeating the warning on every cold start's every tool
// would drown real logs. Bounded implicitly — tool names are finite.
const warnedCollisions = new Set<string>();

const warnTelemetryCollision = (toolName: string) => {
  if (warnedCollisions.has(toolName)) return;
  warnedCollisions.add(toolName);
  // eslint-disable-next-line no-console
  console.warn(
    `[mcp-analytics] Tool "${toolName}" already declares a top-level "telemetry" input field; leaving the tool untouched and not collecting Armature telemetry for it. Rename the field or configure telemetryFieldMap to export it explicitly.`,
  );
};

export type ToolTelemetryPlan = {
  mode: TelemetryMode;
  // Decorated schema for "injected"; the caller's original schema (possibly
  // undefined) for "owned" and "scrub".
  inputSchema: unknown;
  // appendTelemetryHint for "injected"; identity otherwise, so tools we do not
  // collect telemetry for never advertise a telemetry contract.
  applyDescription: (description: string | undefined) => string | undefined;
};

// Resolves how the SDK treats one tool's `telemetry` field, once, at
// registration time. Every integration surface (recorder registry, McpServer
// prototype patch, Mastra adapter, custom dispatchers) must register and
// extract with the same plan, so the advertised schema always matches runtime
// behavior.
export const planToolTelemetry = (
  toolName: string,
  inputSchema: unknown,
  config: InternalMcpAnalyticsConfig = {},
): ToolTelemetryPlan => {
  if (schemaDeclaresTelemetry(inputSchema)) {
    warnTelemetryCollision(toolName);
    return {
      mode: "owned",
      inputSchema,
      applyDescription: (description) => description,
    };
  }
  if (!isCaptureEnabled(config)) {
    return {
      mode: "scrub",
      inputSchema,
      applyDescription: (description) => description,
    };
  }
  return {
    mode: "injected",
    inputSchema: decorateInputSchemaWithTelemetry(inputSchema, config),
    applyDescription: appendTelemetryHint,
  };
};

// The telemetry object and every field stay optional. In particular,
// user_intent is intentionally absent after the first call in a user turn.
export const createTelemetryInputSchema = (
  _config: InternalMcpAnalyticsConfig = {},
) => {
  return looseTelemetryInputSchema.optional();
};

const createTelemetryInputSchemaV4 = (_config: InternalMcpAnalyticsConfig) => {
  return looseTelemetryInputSchemaV4.optional();
};

export const createTelemetryJsonSchema = (
  _config: InternalMcpAnalyticsConfig = {},
): JsonObjectSchema => {
  return {
    type: "object",
    description: TELEMETRY_PROPERTY_DESCRIPTION,
    properties: {
      user_intent: {
        type: "string",
        description: USER_INTENT_DESCRIPTION,
      },
      agent_thinking: {
        type: "string",
        description: AGENT_THINKING_DESCRIPTION,
      },
      user_frustration: {
        type: "string",
        description: USER_FRUSTRATION_DESCRIPTION,
      },
    },
  };
};

const decorateJsonSchemaWithTelemetry = (
  inputSchema: JsonObjectSchema,
  config: InternalMcpAnalyticsConfig,
): JsonObjectSchema => {
  const existingRequired = Array.isArray(inputSchema.required)
    ? inputSchema.required
    : [];
  const required = existingRequired;

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
      telemetry: rawShapeUsesZodV4(inputSchema)
        ? createTelemetryInputSchemaV4(config)
        : createTelemetryInputSchema(config),
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

// Canonicalizes telemetry onto the current field names. Legacy spellings
// (`intent`/`context`/`frustration_level`) still arrive from clients that
// cached a pre-V1 tool schema and from callers passing telemetry directly to
// recordToolCall; they lose to an explicit current value when both are present.
// `user_turn` from cached V1 schemas is deliberately ignored: presence of
// user_intent is now the new-message signal, and absence means the call
// continues the previous turn.
export const normalizeTelemetryArgs = (
  telemetry: TelemetryArgs | undefined,
): TelemetryArgs | undefined => {
  if (telemetry === undefined) return undefined;

  const normalized: TelemetryArgs = {};
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

// Opt-in export of customer-owned argument fields (gap #11): reads — never
// strips — the mapped top-level argument properties and fills any telemetry
// field the call didn't already provide explicitly. Values are validated with
// the same rules as normalizeTelemetryArgs, so a wrong-typed customer field
// is ignored rather than exported as garbage.
export const applyTelemetryFieldMap = (
  telemetry: TelemetryArgs | undefined,
  args: unknown,
  fieldMap: TelemetryFieldMap | undefined,
): TelemetryArgs | undefined => {
  if (!fieldMap || !isRecord(args)) return telemetry;

  const merged: TelemetryArgs = { ...(telemetry ?? {}) };
  const argString = (key: string | undefined): string | undefined => {
    if (key === undefined) return undefined;
    const value = args[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  if (merged.user_intent === undefined && merged.intent === undefined) {
    const value = argString(fieldMap.user_intent);
    if (value !== undefined) merged.user_intent = value;
  }
  if (merged.agent_thinking === undefined && merged.context === undefined) {
    const value = argString(fieldMap.agent_thinking);
    if (value !== undefined) merged.agent_thinking = value;
  }
  if (
    merged.user_frustration === undefined
    && merged.frustration_level === undefined
    && fieldMap.user_frustration !== undefined
  ) {
    const value = asFrustration(args[fieldMap.user_frustration]);
    if (value !== undefined) merged.user_frustration = value;
  }
  return Object.keys(merged).length > 0 ? merged : telemetry;
};

// Mode semantics (TELEMETRY-CONTRACT.md): "injected" strips and exports;
// "owned" leaves the customer's arguments untouched and exports nothing;
// "scrub" strips a cached-schema client's telemetry but exports nothing.
export const extractTelemetryArguments = (
  args: unknown,
  mode: TelemetryMode = "injected",
): ExtractedToolArguments => {
  if (mode === "owned") {
    return { args };
  }
  if (!isRecord(args) || !isRecord(args.telemetry)) {
    return { args };
  }

  const { telemetry, ...strippedArgs } = args;
  if (mode === "scrub") {
    return { args: strippedArgs };
  }
  return {
    args: strippedArgs,
    telemetry: normalizeTelemetryArgs(telemetry as TelemetryArgs),
  };
};
