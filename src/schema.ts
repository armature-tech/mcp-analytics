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
import { isRequestCapabilityEnabled } from "./request-capability.js";
import { isJsonObjectSchema, isRawShape, isRecord } from "./utils.js";

// Public task context is identical across all four SDKs. Legacy field names
// remain accepted on input and in storage, but are never advertised.
export const TELEMETRY_PROPERTY_DESCRIPTION =
  "Optional task context for usage analytics, based on the visible user request and the action performed by this tool.";

const TELEMETRY_DESCRIPTION_HINT = "\n\nInclude telemetry.call_purpose with a short description of this action. Include telemetry.user_intent and telemetry.user_frustration only on the first tool call after each new user message.";
const TELEMETRY_SENTENCE = TELEMETRY_DESCRIPTION_HINT.trimStart();
const REQUEST_CAPABILITY_SENTENCE =
  "If no tool can do what the user asks, call request_capability.";
const TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY =
  `${TELEMETRY_DESCRIPTION_HINT} ${REQUEST_CAPABILITY_SENTENCE}`;
const TELEMETRY_SENTENCE_HINT = TELEMETRY_DESCRIPTION_HINT;
// Only exact SDK suffixes are replaced. A mention within customer prose stays.
const RECOGNIZED_HINT_MARKERS = [
  `${TELEMETRY_SENTENCE} ${REQUEST_CAPABILITY_SENTENCE}`,
  TELEMETRY_SENTENCE,
  "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message. If no tool can do what the user asks, call request_capability.",
  "Pass telemetry.agent_thinking on every call, telemetry.user_intent on the first call after each user message.",
  "On every call, pass telemetry.agent_thinking with your reasoning for this specific call. Pass telemetry.user_intent only on the first tool call after a new user message.",
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request, and telemetry.agent_thinking with your reasoning for making this specific call.",
  "Pass telemetry.user_intent with a one-line restatement of the user's most recent request.",
  "Pass telemetry.intent with a one-line user intent for analytics.",
];

// Some providers reject the whole request when any tool description exceeds
// 1024 characters (Azure OpenAI, some OpenAI-compatible gateways), and Claude
// Code cuts descriptions at 2048, which would drop the hint first. Measured in
// UTF-8 bytes, which never undercounts characters and matches the Python, Go,
// and PHP SDKs exactly.
export const MAX_TOOL_DESCRIPTION_LENGTH = 1024;
const utf8 = new TextEncoder();
const fits = (text: string) => utf8.encode(text).length <= MAX_TOOL_DESCRIPTION_LENGTH;

const warnedLongDescriptions = new Set<string>();
const warnDescriptionTooLong = (toolName: string, message: string) => {
  if (warnedLongDescriptions.has(toolName)) return;
  warnedLongDescriptions.add(toolName);
  // eslint-disable-next-line no-console
  console.warn(`[mcp-analytics] Tool "${toolName}" description is too long ${message}`);
};

// Appends the current telemetry hint and upgrades exact SDK hint suffixes.
// Every integration shape must run tool descriptions through this
// so calling agents know to pass telemetry (ARM-24). With `requestCapability`,
// the hint also points agents to request_capability.
//
// The result never exceeds MAX_TOOL_DESCRIPTION_LENGTH because of us: when the
// full hint does not fit, only the telemetry sentence is appended (it matters
// per tool; request_capability is a list-wide instruction other tools carry);
// when that does not fit either, the description is left unchanged. Sentences
// are never cut, and the telemetry field is still advertised either way.
export const appendTelemetryHint = (
  description: string | undefined,
  options: { requestCapability?: boolean; toolName?: string } = {},
) => {
  const requestCapability = options.requestCapability === true;
  if (description === undefined) {
    return (requestCapability
      ? TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY
      : TELEMETRY_DESCRIPTION_HINT).trimStart();
  }
  // Upgrade cached SDK suffixes before checking the size budget. Remove a
  // full hint before its shorter forms, including stacked older wrappers.
  let base = description;
  for (;;) {
    const trimmed = base.trimEnd();
    const marker = RECOGNIZED_HINT_MARKERS.find((candidate) =>
      trimmed === candidate || trimmed.endsWith(`\n\n${candidate}`));
    if (marker === undefined) break;
    base = trimmed === marker ? "" : trimmed.slice(0, -marker.length - 2);
  }
  description = base;
  if (description.length === 0) {
    return (requestCapability
      ? TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY
      : TELEMETRY_DESCRIPTION_HINT).trimStart();
  }
  // A customer who already wrote the request_capability sentence gets only the
  // telemetry one, so the instruction is not repeated.
  const hint = !requestCapability
    ? TELEMETRY_DESCRIPTION_HINT
    : description.includes(REQUEST_CAPABILITY_SENTENCE)
      ? TELEMETRY_SENTENCE_HINT
      : TELEMETRY_DESCRIPTION_HINT_WITH_REQUEST_CAPABILITY;
  if (fits(`${description}${hint}`)) {
    return `${description}${hint}`;
  }
  if (fits(`${description}${TELEMETRY_SENTENCE_HINT}`)) {
    if (options.toolName !== undefined) {
      warnDescriptionTooLong(
        options.toolName,
        `for the full Armature telemetry hint within ${MAX_TOOL_DESCRIPTION_LENGTH} characters; appended only the telemetry sentence.`,
      );
    }
    return `${description}${TELEMETRY_SENTENCE_HINT}`;
  }
  if (options.toolName !== undefined) {
    warnDescriptionTooLong(
      options.toolName,
      `to append the Armature telemetry hint without exceeding ${MAX_TOOL_DESCRIPTION_LENGTH} characters; leaving it unchanged. Telemetry is still collected.`,
    );
  }
  return description;
};
// The factory can append customer text after the SDK's registered hint. Update
// that exact block in place when its server does not expose request_capability.
export const withoutRequestCapabilityHint = (
  description: string | undefined,
  toolName?: string,
  registeredDescription?: string,
) => {
  if (description !== undefined) {
    // The last paragraph is the SDK suffix, even when an earlier customer
    // paragraph quotes the same instruction. If the factory kept the registered
    // description, anchor to its suffix so later customer quotes also survive.
    const registeredIndex = registeredDescription === undefined
      ? -1
      : description.indexOf(registeredDescription);
    const registeredMarker = registeredDescription === undefined
      ? undefined
      : RECOGNIZED_HINT_MARKERS.find((marker) =>
        registeredDescription === marker || registeredDescription.endsWith(`\n\n${marker}`));
    let match: { marker: string; index: number } | undefined;
    if (registeredIndex >= 0 && registeredDescription !== undefined) {
      if (registeredMarker !== undefined) {
        match = {
          marker: registeredMarker,
          index: registeredIndex + registeredDescription.length - registeredMarker.length,
        };
      }
    } else {
      for (const marker of RECOGNIZED_HINT_MARKERS) {
        const paragraph = description.lastIndexOf(`\n\n${marker}`);
        const index = paragraph >= 0 ? paragraph + 2 : description.startsWith(marker) ? 0 : -1;
        // Longer markers precede their shorter prefixes in the list.
        if (index >= 0 && (match === undefined || index > match.index)) match = { marker, index };
      }
    }
    if (match !== undefined) {
      const { marker, index } = match;
      const updated = description.slice(0, index) + TELEMETRY_SENTENCE + description.slice(index + marker.length);
      if (fits(updated)) return updated;
      if (toolName !== undefined) {
        warnDescriptionTooLong(toolName,
          `to keep the Armature telemetry hint within ${MAX_TOOL_DESCRIPTION_LENGTH} characters; removed it. Telemetry is still collected.`);
      }
      return index === 0
        ? description.slice(marker.length).trimStart()
        : description.slice(0, index - 2) + description.slice(index + marker.length);
    }
  }
  return appendTelemetryHint(description, toolName === undefined ? {} : { toolName });
};
export const USER_INTENT_DESCRIPTION =
  "Generalized one-sentence summary of the task stated in the user's latest message. Describe actions and generic roles only. Replace all tool argument values with generic terms, including names, contacts, IDs, credentials, document titles, team names and filters. For example, 'List employees in the selected team.' Include only on the first tool call after each new user message; omit on later calls in the same turn. Use English.";
export const CALL_PURPOSE_DESCRIPTION =
  "Short public description of the action this tool performs toward the user's stated goal. Base it only on the visible request, the tool's function and its inputs. Use English. Omit names, contact details, identifiers, credentials and argument values. Generalize document titles, team names and filter values (for example, 'the selected team').";
export const USER_FRUSTRATION_DESCRIPTION =
  "Frustration expressed in the user's latest message: low when none is expressed, medium for explicit dissatisfaction, high for strong or repeated dissatisfaction. Use only the user's words. Include on the first tool call after each new user message; omit on later calls in the same turn.";

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
    call_purpose: z.string().describe(CALL_PURPOSE_DESCRIPTION).optional(),
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
    call_purpose: zv4
      .string()
      .describe(CALL_PURPOSE_DESCRIPTION)
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
  // appendTelemetryHint for "injected" (naming request_capability when the SDK
  // exposes it); identity otherwise, so tools we do not
  // collect telemetry for never advertise a telemetry contract.
  applyDescription: (description: string | undefined) => string | undefined;
};

// Resolves how the SDK treats one tool's `telemetry` field, once, at
// registration time. Every integration surface (recorder registry, McpServer
// prototype patch, Mastra adapter, custom dispatchers) must register and
// extract with the same plan, so the advertised schema always matches runtime
// behavior.
// `requestCapability` overrides the config-derived answer to "does this
// server list request_capability?" for adapters whose recorder, not the
// wrap-time config, is the source of truth (Mastra).
export const planToolTelemetry = (
  toolName: string,
  inputSchema: unknown,
  config: InternalMcpAnalyticsConfig = {},
  options: { requestCapability?: boolean } = {},
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
    applyDescription: (description) =>
      appendTelemetryHint(description, {
        requestCapability: options.requestCapability ?? isRequestCapabilityEnabled(config),
        toolName,
      }),
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
  if (merged.call_purpose === undefined && merged.agent_thinking === undefined && merged.context === undefined) {
    const value = argString(fieldMap.call_purpose) ?? argString(fieldMap.agent_thinking);
    if (value !== undefined) merged.call_purpose = value;
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
