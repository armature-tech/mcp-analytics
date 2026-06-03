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
