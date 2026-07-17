import type { RedactFunction } from "./types.js";
import { isRecord } from "./utils.js";

// Placeholder strings are part of the cross-SDK contract
// (packages/TELEMETRY-CONTRACT.md) — golden tests in all three SDKs assert
// them byte-for-byte.
export const BINARY_REMOVED_PLACEHOLDER = "[binary removed]";
export const BASE64_REMOVED_PLACEHOLDER = "[base64 removed]";
export const REDACTION_FAILED_PLACEHOLDER = "[redaction failed]";

// A data: URI with a base64 payload is binary at any plausible size; plain
// strings need the higher bar (length + strict charset) so prose, ids, and
// hashes below half a KB pass through untouched. Both thresholds are contract
// values — keep in sync with the Python and Go SDKs.
const DATA_URI_MIN_CHARS = 64;
const BASE64_MIN_CHARS = 512;

// Strict charset on purpose: no whitespace, so long prose (letters + spaces)
// never matches. Covers standard base64 and base64url, with optional padding.
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

// Recursively strips binary and base64 payloads from a tool input/output
// value before it is serialized into previews (gap #1). MCP image/audio
// content blocks lose their `data`, resource blobs lose their `blob`, and
// long base64 strings are replaced wholesale. Cycle-safe: the tracker holds
// only the CURRENT descent path (entries are removed on the way back up), so
// content legitimately shared between two branches is sanitized in both
// places while a true cycle serializes as "[circular]" instead of
// overflowing. Matches the Python and Go sanitizers.
export const sanitizeValue = (value: unknown, seen?: WeakSet<object>): unknown => {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value !== "object" || value === null) return value;

  const tracked = seen ?? new WeakSet<object>();
  if (tracked.has(value)) return "[circular]";
  tracked.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, tracked));
    }
    if (!isRecord(value)) return value;

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        key === "data"
        && typeof entry === "string"
        && (value.type === "image" || value.type === "audio")
      ) {
        out[key] = BINARY_REMOVED_PLACEHOLDER;
      } else if (key === "blob" && typeof entry === "string") {
        out[key] = BINARY_REMOVED_PLACEHOLDER;
      } else {
        out[key] = sanitizeValue(entry, tracked);
      }
    }
    return out;
  } finally {
    tracked.delete(value);
  }
};

// sanitize → customer redact, failing closed: a throwing hook replaces the
// whole payload with the placeholder rather than shipping unredacted data.
// The event itself still ships — losing a preview is recoverable, silently
// dropping calls from analytics is not.
export const prepareForPreview = (
  value: unknown,
  redact: RedactFunction | undefined,
): unknown => {
  const sanitized = sanitizeValue(value);
  if (!redact) return sanitized;
  try {
    return redact(sanitized);
  } catch {
    return REDACTION_FAILED_PLACEHOLDER;
  }
};
