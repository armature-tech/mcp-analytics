import { z } from "zod";
import * as zv4 from "zod/v4";
import type {
  ExtractedToolArguments,
  InternalMcpAnalyticsConfig,
  JsonObjectSchema,
  TelemetryArgs,
  TelemetryFieldMap,
  TelemetryMode,
  DescriptionLengthLogLevel,
} from "./types.js";
import { isJsonObjectSchema, isRawShape, isRecord } from "./utils.js";

// Public task context is identical across all four SDKs. Legacy field names
// remain accepted on input and in storage, but are never advertised.
export const TELEMETRY_PROPERTY_DESCRIPTION =
  "Optional task context for usage analytics, based on the visible user request and the action performed by this tool.";

// Earlier releases appended these sentences to every tool description. The SDK
// no longer adds text to a tool description (TELEMETRY-CONTRACT.md, "Tool
// descriptions"): what the agent is asked for lives in the injected
// parameters' own descriptions, as in the PostHog and AgentCat SDKs.
// Anthropic's connector directory review asked for exactly this. Exact SDK
// suffixes from those releases are still removed, so a description registered
// through an older wrapper or a cached factory comes out clean.
const TELEMETRY_SENTENCE = "Include telemetry.call_purpose with a short description of this action. Include telemetry.user_intent and telemetry.user_frustration only on the first tool call after each new user message.";
const REQUEST_CAPABILITY_SENTENCE =
  "Call request_capability before you tell the user something can't be done here or has to be done elsewhere.";
// Only exact SDK suffixes are removed. A mention within customer prose stays.
// Longer markers precede their shorter prefixes.
const RECOGNIZED_HINT_MARKERS = [
  `${TELEMETRY_SENTENCE} ${REQUEST_CAPABILITY_SENTENCE}`,
  `${TELEMETRY_SENTENCE} If no tool can do what the user asks, call request_capability.`,
  TELEMETRY_SENTENCE,
  "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message. If no tool can do what the user asks, call request_capability.",
  "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message.",
  "On every call, pass telemetry.agent_thinking with your reasoning for this specific call. Pass telemetry.user_intent only on the first tool call after a new user message.",
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request, and telemetry.agent_thinking with your reasoning for making this specific call.",
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request.",
  "Pass telemetry.intent with a one-line user intent for analytics.",
];

/**
 * Kept for compatibility: the SDK no longer appends anything to tool
 * descriptions, so no description can grow past this because of us.
 */
export const MAX_TOOL_DESCRIPTION_LENGTH = 1024;

// Removes the SDK's own trailing hint paragraph(s), stacked older wrappers
// included. A description that was only an SDK hint becomes empty; a tool with
// no description keeps none.
export const stripSdkDescriptionHint = (description: string | undefined) => {
  if (description === undefined) return undefined;
  let base = description;
  for (;;) {
    const trimmed = base.trimEnd();
    const marker = RECOGNIZED_HINT_MARKERS.find((candidate) =>
      trimmed === candidate || trimmed.endsWith(`\n\n${candidate}`));
    if (marker === undefined) return base;
    base = trimmed === marker ? "" : trimmed.slice(0, -marker.length - 2);
  }
};

/**
 * @deprecated Appends nothing. The SDK no longer adds text to tool
 * descriptions; this only removes SDK hint suffixes from earlier releases.
 * The options are accepted and ignored.
 */
export const appendTelemetryHint = (
  description: string | undefined,
  _options: {
    requestCapability?: boolean;
    toolName?: string;
    logLevel?: DescriptionLengthLogLevel;
  } = {},
) => stripSdkDescriptionHint(description);

export const USER_INTENT_DESCRIPTION =
  "Generalized one-sentence summary of the task stated in the user's latest message. Describe actions and generic roles only. Replace all tool argument values with generic terms, including names, contacts, IDs, credentials, document titles, team names and filters. For example, 'List employees in the selected team.' Include only on the first tool call after each new user message; omit on later calls in the same turn. Use English.";
export const CALL_PURPOSE_DESCRIPTION =
  "Short public description of the action this tool performs toward the user's stated goal. Base it only on the visible request, the tool's function and its inputs. Use English. Omit names, contact details, identifiers, credentials and argument values. Generalize document titles, team names and filter values (for example, 'the selected team').";
// Each telemetry object schema carries the object-level description via
// `.describe(...)` so it survives zod→JSON-schema conversion in every
// integration shape — including caller-owned McpServer registration, where no
// post-hoc JSON-schema nudge runs (ARM-24).
//
// `.passthrough()` keeps unknown keys: a client that cached an older tool
// schema may still send `intent`/`context`, and stripping them here would
// silently drop its telemetry before normalizeTelemetryArgs can translate the
// legacy spelling. A cached `user_frustration`/`frustration_level` passes
// validation too and is then dropped.
//
const looseTelemetryInputSchema = z
  .object({
    user_intent: z.string().describe(USER_INTENT_DESCRIPTION).optional(),
    call_purpose: z.string().describe(CALL_PURPOSE_DESCRIPTION).optional(),
  })
  .passthrough()
  .describe(TELEMETRY_PROPERTY_DESCRIPTION);

const looseTelemetryInputSchemaV4 = zv4
  .looseObject({
    user_intent: zv4.string().describe(USER_INTENT_DESCRIPTION).optional(),
    call_purpose: zv4
      .string()
      .describe(CALL_PURPOSE_DESCRIPTION)
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
  // Removes SDK hint suffixes from earlier releases for "injected"; identity
  // otherwise. Never adds text.
  applyDescription: (description: string | undefined) => string | undefined;
};

// Resolves how the SDK treats one tool's `telemetry` field, once, at
// registration time. Every integration surface (recorder registry, McpServer
// prototype patch, Mastra adapter, custom dispatchers) must register and
// extract with the same plan, so the advertised schema always matches runtime
// behavior.
// `_options` is accepted for adapters built against earlier releases; no
// description mentions request_capability any more.
export const planToolTelemetry = (
  toolName: string,
  inputSchema: unknown,
  config: InternalMcpAnalyticsConfig = {},
  _options: { requestCapability?: boolean } = {},
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
    applyDescription: stripSdkDescriptionHint,
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
      call_purpose: {
        type: "string",
        description: CALL_PURPOSE_DESCRIPTION,
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

// First value that is actually a string — mirrors Python's _first_str so both
// SDKs resolve mixed V1/legacy inputs identically (a non-string V1 value never
// shadows a usable legacy string).
const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
};

// Maps public call_purpose onto the existing agent_thinking storage field.
// Canonicalizes telemetry onto the storage field names. Legacy spellings
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
  const agentThinking = firstString(telemetry.call_purpose, telemetry.agent_thinking, telemetry.context);
  if (agentThinking !== undefined) normalized.agent_thinking = agentThinking;
  // `user_frustration`/`frustration_level` from cached schemas are dropped:
  // the SDK no longer asks agents to rate the user.
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
  if (merged.call_purpose === undefined && merged.agent_thinking === undefined && merged.context === undefined) {
    const value = argString(fieldMap.call_purpose) ?? argString(fieldMap.agent_thinking);
    if (value !== undefined) merged.call_purpose = value;
  }
  // A `user_frustration` mapping is accepted and ignored.
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
