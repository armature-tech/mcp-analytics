import { redactSecretsInValue } from "./redact-secrets.js";
import type { RedactFunction } from "./types.js";
import { isRecord } from "./utils.js";

export const BINARY_REMOVED_PLACEHOLDER = "[binary removed]";
export const BASE64_REMOVED_PLACEHOLDER = "[base64 removed]";
export const REDACTION_FAILED_PLACEHOLDER = "[redaction failed]";
export const SANITIZATION_BUDGET = 65_536;

const DATA_URI_MIN_CHARS = 64;
const BASE64_MIN_CHARS = 512;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

const isBase64Payload = (value: string): boolean => {
  if (value.length >= DATA_URI_MIN_CHARS && value.startsWith("data:") && value.includes(";base64,")) {
    return true;
  }
  return value.length >= BASE64_MIN_CHARS && BASE64_RE.test(value);
};

const sanitizeString = (value: string): string => {
  return isBase64Payload(value) ? BASE64_REMOVED_PLACEHOLDER : value;
};

type Budget = { remaining: number };

const charge = (budget: Budget, units: number): boolean => {
  if (budget.remaining < units) {
    budget.remaining = 0;
    return false;
  }
  budget.remaining -= units;
  return true;
};

const sanitizeValueBounded = (
  value: unknown,
  seen: WeakSet<object>,
  budget: Budget,
): unknown => {
  if (typeof value === "string") {
    const sanitized = sanitizeString(value);
    if (sanitized.length <= budget.remaining) {
      budget.remaining -= sanitized.length;
      return sanitized;
    }
    const sliced = sanitized.slice(0, budget.remaining);
    budget.remaining = 0;
    return sliced;
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return sanitizeValueBounded("[circular]", seen, budget);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        if (!charge(budget, 2)) break;
        out.push(sanitizeValueBounded(item, seen, budget));
        if (budget.remaining === 0) break;
      }
      return out;
    }
    if (!isRecord(value)) return value;

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!charge(budget, key.length + 2)) break;
      if (
        key === "data"
        && typeof entry === "string"
        && (value.type === "image" || value.type === "audio")
      ) {
        out[key] = sanitizeValueBounded(BINARY_REMOVED_PLACEHOLDER, seen, budget);
      } else if (key === "blob" && typeof entry === "string") {
        out[key] = sanitizeValueBounded(BINARY_REMOVED_PLACEHOLDER, seen, budget);
      } else {
        out[key] = sanitizeValueBounded(entry, seen, budget);
      }
      if (budget.remaining === 0) break;
    }
    return out;
  } finally {
    seen.delete(value);
  }
};

export const sanitizeValue = (value: unknown, seen?: WeakSet<object>): unknown => {
  return sanitizeValueBounded(
    value,
    seen ?? new WeakSet<object>(),
    { remaining: SANITIZATION_BUDGET },
  );
};

export type PrepareForPreviewOptions = { redactSecrets?: boolean };

export const prepareForPreview = (
  value: unknown,
  redact?: RedactFunction,
  options: PrepareForPreviewOptions = {},
): unknown => {
  const sanitized = sanitizeValue(value);
  const protectedValue = options.redactSecrets === false
    ? sanitized
    : redactSecretsInValue(sanitized);
  if (!redact) return protectedValue;
  try {
    return redact(protectedValue);
  } catch {
    return REDACTION_FAILED_PLACEHOLDER;
  }
};
