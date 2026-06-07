import { createHash } from "node:crypto";
import type { HeaderBag, JsonObjectSchema } from "./types.js";

export const SCHEMA_VERSION = 1 as const;
export const MAX_SOURCE_BYTES = 32 * 1024;
export const MAX_PREVIEW_BYTES = 8 * 1024;
export const MAX_CAPABILITIES_BYTES = 4 * 1024;

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const isJsonObjectSchema = (value: unknown): value is JsonObjectSchema => {
  return isRecord(value) && value.type === "object";
};

export const isRawShape = (value: unknown): value is Record<string, unknown> => {
  return (
    isRecord(value) &&
    !("_def" in value) &&
    !("_zod" in value) &&
    !isJsonObjectSchema(value)
  );
};

export const readEnv = (key: string) => {
  return typeof process !== "undefined" ? process.env[key] : undefined;
};

export const sha256Hex = (value: string) => {
  return createHash("sha256").update(value).digest("hex");
};

// Minimal `has`/`add` surface so a plain `Set<string>` is structurally
// assignable (tests pass `new Set()` directly).
export type BoundedKeySet = {
  has: (key: string) => boolean;
  add: (key: string) => void;
};

// A `Set<string>` capped at `maxEntries` with FIFO eviction (Map/Set iteration
// order is insertion order in JS, so the first key is the oldest). MCP fires no
// reliable "session-closed" signal, so an unbounded set of session keys would
// leak forever on a long-running server with high session churn — the same
// reasoning behind the client-info cache's bound. Eviction is safe because the
// only consumers (`session_init` de-dup) now derive a stable `event_id` per
// (actorId, sessionId), so a re-emitted `session_init` after eviction collapses
// to the same id at ingest rather than double-counting.
export const createBoundedKeySet = (maxEntries: number): BoundedKeySet => {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      if (keys.has(key)) return;
      if (keys.size >= maxEntries) {
        const oldest = keys.values().next().value;
        if (oldest !== undefined) keys.delete(oldest);
      }
      keys.add(key);
    },
  };
};

export const stringifyPreview = (value: unknown) => {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
};

export const truncateUtf8 = (value: string, maxBytes: number) => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
};

export const headerValue = (headers: HeaderBag | undefined, name: string) => {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const lower = name.toLowerCase();
  let value: string | string[] | undefined = headers[name] ?? headers[lower];
  if (value === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        value = headers[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};
