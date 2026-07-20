import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_INGEST_URL = "https://app.armature.tech/api/mcp-analytics/ingest";
const DEFAULT_TIMEOUT_MS = 10_000;
const CURRENT_TELEMETRY_MARKER = "Conversation telemetry.";
const LEGACY_TELEMETRY_MARKERS = [
  "Pass telemetry.user_intent",
  "Pass telemetry.intent",
];

type UnknownRecord = Record<string, unknown>;

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  label: string;
  detail: string;
  remediation?: string;
};

export type DoctorTarget =
  | { kind: "http"; url: string; headers: Record<string, string> }
  | { kind: "stdio"; command: string; args: string[]; cwd: string };

export type DoctorOptions = {
  target: DoctorTarget;
  cwd: string;
  timeoutMs: number;
  expectCapture: boolean;
  skipIngest: boolean;
  json: boolean;
};

export type DoctorReport = {
  healthy: boolean;
  target: "http" | "stdio";
  checks: DoctorCheck[];
};

export type DoctorTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpInspection = {
  serverName?: string;
  serverVersion?: string;
  tools: DoctorTool[];
};

export type LocalSdk = {
  language: "typescript" | "python" | "go";
  declaration: string;
};

export type DoctorDependencies = {
  inspectMcp: (options: DoctorOptions) => Promise<McpInspection>;
  detectLocalSdks: (cwd: string) => Promise<LocalSdk[]>;
  verifyIngest: (endpoint: string, apiKey: string, timeoutMs: number) => Promise<void>;
};

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "unknown error");
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const currentProcessEnvironment = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
};

export const inspectMcp = async (options: DoctorOptions): Promise<McpInspection> => {
  const client = new Client({ name: "armature-mcp-doctor", version: "1" });
  const transport = options.target.kind === "http"
    ? new StreamableHTTPClientTransport(new URL(options.target.url), {
        requestInit: { headers: options.target.headers },
      })
    : new StdioClientTransport({
        command: options.target.command,
        args: options.target.args,
        cwd: options.target.cwd,
        env: currentProcessEnvironment(),
        stderr: "pipe",
      });

  if (transport instanceof StdioClientTransport) {
    // The SDK exposes the PassThrough before spawning the child, so start
    // draining immediately. Otherwise a chatty server can fill the bounded
    // stderr pipe and block before it answers the MCP handshake.
    transport.stderr?.on("data", () => undefined);
  }

  try {
    await withTimeout(client.connect(transport), options.timeoutMs, "MCP initialize");
    const listed = await withTimeout(client.listTools(), options.timeoutMs, "MCP tools/list");
    const server = client.getServerVersion();
    return {
      serverName: server?.name,
      serverVersion: server?.version,
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  } finally {
    // Some stdio servers do not exit promptly after stdin closes. Diagnostics
    // must still return a result instead of hanging on cleanup.
    await withTimeout(client.close(), Math.min(options.timeoutMs, 1_000), "MCP close")
      .catch(() => {
        if (transport instanceof StdioClientTransport && transport.pid) {
          try {
            process.kill(transport.pid, "SIGTERM");
          } catch {
            // The child may already have exited between the pid read and kill.
          }
        }
      });
  }
};

const telemetryShape = (tool: DoctorTool): UnknownRecord | null => {
  if (!isRecord(tool.inputSchema)) return null;
  const properties = tool.inputSchema.properties;
  if (!isRecord(properties)) return null;
  return isRecord(properties.telemetry) ? properties.telemetry : null;
};

export const classifyToolInstrumentation = (
  tool: DoctorTool,
): "current" | "legacy" | "owned" | "missing" => {
  const inputProperties = isRecord(tool.inputSchema)
    && isRecord(tool.inputSchema.properties)
    ? tool.inputSchema.properties
    : null;
  const ownsTelemetryField = Boolean(inputProperties && "telemetry" in inputProperties);
  const telemetry = telemetryShape(tool);
  if (!telemetry) return ownsTelemetryField ? "owned" : "missing";
  const properties = isRecord(telemetry.properties) ? telemetry.properties : {};
  const telemetryDescription = typeof telemetry.description === "string"
    ? telemetry.description
    : "";
  const toolDescription = tool.description || "";

  if (
    "agent_thinking" in properties
    && "user_intent" in properties
    && telemetryDescription.includes(CURRENT_TELEMETRY_MARKER)
  ) {
    return "current";
  }

  if (
    "intent" in properties
    || "context" in properties
    || LEGACY_TELEMETRY_MARKERS.some((marker) => toolDescription.includes(marker))
  ) {
    return "legacy";
  }

  return ownsTelemetryField ? "owned" : "missing";
};

export const inspectToolCoverage = (tools: DoctorTool[]) => {
  const current: string[] = [];
  const legacy: string[] = [];
  const owned: string[] = [];
  const missing: string[] = [];
  for (const tool of tools) {
    const classification = classifyToolInstrumentation(tool);
    if (classification === "current") current.push(tool.name);
    else if (classification === "legacy") legacy.push(tool.name);
    else if (classification === "owned") owned.push(tool.name);
    else missing.push(tool.name);
  }
  return { current, legacy, owned, missing, total: tools.length };
};

const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
};

export const detectLocalSdks = async (cwd: string): Promise<LocalSdk[]> => {
  const found: LocalSdk[] = [];
  const packageJson = await readIfPresent(resolve(cwd, "package.json"));
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as UnknownRecord;
      const sections = [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies];
      for (const section of sections) {
        if (isRecord(section) && typeof section["@armature-tech/mcp-analytics"] === "string") {
          found.push({
            language: "typescript",
            declaration: `@armature-tech/mcp-analytics ${section["@armature-tech/mcp-analytics"]}`,
          });
          break;
        }
      }
    } catch {
      // A malformed package.json will be reported by the customer's package manager.
    }
  }

  const pyproject = await readIfPresent(resolve(cwd, "pyproject.toml"));
  const requirements = await readIfPresent(resolve(cwd, "requirements.txt"));
  const pythonDeclaration = [pyproject, requirements]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .match(/armature-mcp-analytics(?:\[[^\]]+\])?(?:\s*[<>=~!]+\s*[^\s"',\]]+)?/i)?.[0];
  if (pythonDeclaration) {
    found.push({ language: "python", declaration: pythonDeclaration.replace(/["',]/g, "") });
  }

  const goMod = await readIfPresent(resolve(cwd, "go.mod"));
  const goDeclaration = goMod
    ?.match(/github\.com\/armature-tech\/mcp-analytics-go(?:\/[^\s]+)?\s+v[^\s)]+/)?.[0];
  if (goDeclaration) found.push({ language: "go", declaration: goDeclaration });

  return found;
};

export const verifyIngest = async (
  endpoint: string,
  apiKey: string,
  timeoutMs: number,
): Promise<void> => {
  const url = new URL(endpoint);
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
    throw new Error("ingest URL must use http or https");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The ingest route resolves bearer auth before accepting an empty batch,
    // so this validates reachability and the key without creating a session or
    // sending tool, user, or response content. Keep that server contract covered
    // by test/api-mcp-analytics-ingest-doctor.test.js.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ schema_version: 1, events: [] }),
      signal: controller.signal,
    });
    // Drain the body so undici can release its pooled connection promptly and
    // the one-shot CLI does not appear to hang after printing the report.
    await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(`Armature ingest returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

const pass = (id: string, label: string, detail: string): DoctorCheck => ({
  id, label, detail, status: "pass",
});
const warn = (id: string, label: string, detail: string, remediation?: string): DoctorCheck => ({
  id, label, detail, status: "warn", ...(remediation ? { remediation } : {}),
});
const fail = (id: string, label: string, detail: string, remediation?: string): DoctorCheck => ({
  id, label, detail, status: "fail", ...(remediation ? { remediation } : {}),
});

export const runDoctor = async (
  options: DoctorOptions,
  dependencies: DoctorDependencies = { inspectMcp, detectLocalSdks, verifyIngest },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> => {
  const checks: DoctorCheck[] = [];

  try {
    const sdks = await dependencies.detectLocalSdks(options.cwd);
    if (sdks.length === 0) {
      checks.push(warn(
        "sdk-declaration",
        "SDK dependency",
        "No Armature SDK declaration was found in this directory.",
        "Run the doctor from the MCP project root, or confirm the SDK is installed in the deployed project.",
      ));
    } else {
      checks.push(pass(
        "sdk-declaration",
        "SDK dependency",
        sdks.map((sdk) => `${sdk.language}: ${sdk.declaration}`).join("; "),
      ));
    }
  } catch (error) {
    checks.push(warn("sdk-declaration", "SDK dependency", errorMessage(error)));
  }

  try {
    const inspection = await dependencies.inspectMcp(options);
    const identity = [inspection.serverName, inspection.serverVersion].filter(Boolean).join(" ");
    checks.push(pass(
      "mcp-initialize",
      "MCP initialize",
      identity ? `Connected to ${identity}.` : "The server completed the MCP handshake.",
    ));

    if (inspection.tools.length === 0) {
      checks.push(fail(
        "tools-list",
        "Tool discovery",
        "The server returned zero tools, so wrapping cannot be verified.",
        "Register at least one tool and run the doctor again.",
      ));
    } else {
      checks.push(pass(
        "tools-list",
        "Tool discovery",
        `The server returned ${inspection.tools.length} tool${inspection.tools.length === 1 ? "" : "s"}.`,
      ));
      const coverage = inspectToolCoverage(inspection.tools);
      if (!options.expectCapture) {
        const exposed = coverage.current.length + coverage.legacy.length;
        checks.push(exposed === 0
          ? pass("tool-wrapping", "Telemetry capture", "No Armature telemetry fields are advertised, as requested.")
          : warn(
              "tool-wrapping",
              "Telemetry capture",
              `${exposed}/${coverage.total} tools still advertise Armature telemetry fields.`,
              "Confirm captureTelemetry=false is applied before tools are registered.",
            ));
      } else if (coverage.missing.length > 0) {
        const sample = coverage.missing.slice(0, 5).join(", ");
        checks.push(fail(
          "tool-wrapping",
          "Tool wrapping",
          `${coverage.missing.length}/${coverage.total} tools do not expose the Armature telemetry contract${sample ? `: ${sample}` : ""}.`,
          "Wrap the same server instance that is started, and register tools inside withMcpAnalytics or through an Armature recorder.",
        ));
      } else if (coverage.legacy.length > 0) {
        checks.push(warn(
          "tool-wrapping",
          "Tool wrapping",
          `All ${coverage.total} tools are wrapped, but ${coverage.legacy.length} use the legacy telemetry contract.`,
          "Upgrade the Armature SDK and restart the MCP server.",
        ));
      } else if (coverage.owned.length > 0) {
        const sample = coverage.owned.slice(0, 5).join(", ");
        checks.push(warn(
          "tool-wrapping",
          "Tool wrapping",
          `${coverage.current.length}/${coverage.total} tools expose the current Armature telemetry contract; ${coverage.owned.length} own a top-level telemetry field and are intentionally untouched${sample ? `: ${sample}` : ""}.`,
          "Rename the tool-owned telemetry input if you want Armature analytics for that tool, then restart the MCP server.",
        ));
      } else {
        checks.push(pass(
          "tool-wrapping",
          "Tool wrapping",
          `All ${coverage.total} tools expose the current Armature telemetry contract.`,
        ));
      }
    }
  } catch (error) {
    checks.push(fail(
      "mcp-initialize",
      "MCP initialize",
      errorMessage(error),
      options.target.kind === "http"
        ? "Start the MCP server, verify the URL/auth headers, and run the doctor again."
        : "Run the server command directly once, fix startup errors, then run the doctor again.",
    ));
  }

  if (options.skipIngest) {
    checks.push(warn(
      "ingest-auth",
      "Armature ingest",
      "Skipped by --skip-ingest; no network request was made.",
    ));
  } else {
    const apiKey = environment.ANALYTICS_INGEST_API_KEY;
    const endpoint = environment.ANALYTICS_INGEST_URL || DEFAULT_INGEST_URL;
    if (!apiKey) {
      checks.push(fail(
        "ingest-auth",
        "Armature ingest",
        "ANALYTICS_INGEST_API_KEY is not set in the doctor environment.",
        "Export the same ingest key used by the MCP server, then run the doctor again.",
      ));
    } else {
      try {
        await dependencies.verifyIngest(endpoint, apiKey, options.timeoutMs);
        checks.push(pass(
          "ingest-auth",
          "Armature ingest",
          "The endpoint accepted an empty authenticated health probe; no session or customer content was sent.",
        ));
      } catch (error) {
        checks.push(fail(
          "ingest-auth",
          "Armature ingest",
          errorMessage(error),
          "Check ANALYTICS_INGEST_API_KEY and ANALYTICS_INGEST_URL, then run the doctor again.",
        ));
      }
    }
  }

  return {
    healthy: !checks.some((check) => check.status === "fail"),
    target: options.target.kind,
    checks,
  };
};

export const defaultDoctorOptions = (target: DoctorTarget): DoctorOptions => ({
  target,
  cwd: process.cwd(),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  expectCapture: true,
  skipIngest: false,
  json: false,
});
