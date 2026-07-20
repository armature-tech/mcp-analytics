import { isRecord } from "./utils.js";

export type SecretPatternRule = {
  id: string;
  pattern: RegExp;
  replacement: string;
};

// Contract order is significant. Keep these expressions RE2-compatible so
// the TypeScript, Python, and Go implementations continue to agree.
export const SECRET_PATTERN_RULES: readonly SecretPatternRule[] = [
  {
    id: "pem",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[redacted:pem]",
  },
  {
    id: "sensitive-kv",
    pattern: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization)([=:])([^\s"'`,;&]{4,})/gi,
    replacement: "$1$2[redacted:sensitive-kv]",
  },
  {
    id: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}\b/g,
    replacement: "[redacted:aws-access-key-id]",
  },
  {
    id: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
    replacement: "[redacted:github-token]",
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[redacted:google-api-key]",
  },
  {
    id: "slack-token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[redacted:slack-token]",
  },
  {
    id: "stripe-key",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replacement: "[redacted:stripe-key]",
  },
  {
    id: "anthropic-api-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[redacted:anthropic-api-key]",
  },
  {
    id: "openai-api-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[redacted:openai-api-key]",
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[redacted:jwt]",
  },
  {
    id: "connection-string",
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/g,
    replacement: "$1:[redacted:connection-string]@",
  },
  {
    id: "bearer",
    pattern: /\b[Bb]earer +[A-Za-z0-9._~+/=-]{16,}/g,
    replacement: "Bearer [redacted:bearer]",
  },
  {
    id: "basic",
    pattern: /\b[Bb]asic +[A-Za-z0-9+/=]{16,}/g,
    replacement: "Basic [redacted:basic]",
  },
];

export const SENSITIVE_FIELD_NAMES = new Set([
  "password", "passwd", "pwd", "secret", "apikey", "accesskey",
  "secretkey", "secretaccesskey", "token", "accesstoken", "refreshtoken",
  "idtoken", "sessiontoken", "authorization", "auth", "clientsecret",
  "privatekey", "credential", "credentials", "connectionstring",
  "databaseurl", "dsn",
]);

export const normalizeSensitiveFieldName = (key: string): string => {
  return key.toLowerCase().replace(/[_-]/g, "");
};

export const redactSecretsInString = (value: string): string => {
  let redacted = value;
  for (const rule of SECRET_PATTERN_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  return redacted;
};

export const redactSecretsInValue = (
  value: unknown,
  seen?: WeakSet<object>,
): unknown => {
  if (typeof value === "string") return redactSecretsInString(value);
  if (typeof value !== "object" || value === null) return value;

  const tracked = seen ?? new WeakSet<object>();
  if (tracked.has(value)) return "[circular]";
  tracked.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactSecretsInValue(item, tracked));
    }
    if (!isRecord(value)) return value;

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = typeof entry === "string"
        && SENSITIVE_FIELD_NAMES.has(normalizeSensitiveFieldName(key))
        ? "[redacted:sensitive-field]"
        : redactSecretsInValue(entry, tracked);
    }
    return out;
  } finally {
    tracked.delete(value);
  }
};
