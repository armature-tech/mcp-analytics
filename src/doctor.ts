import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  REQUEST_CAPABILITY_DESCRIPTION,
  REQUEST_CAPABILITY_TOOL_NAME,
} from "./request-capability.js";

const DEFAULT_INGEST_URL = "https://app.armature.tech/api/mcp-analytics/ingest";
const DEFAULT_TIMEOUT_MS = 10_000;
const CURRENT_TELEMETRY_MARKER = "Conversation telemetry.";
const LEGACY_TELEMETRY_MARKERS = [
  "Pass telemetry.user_intent",
  "Pass telemetry.intent",
];

type UnknownRecord = Record<string, unknown>;
type DeploymentRegion = "us" | "eu";

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

const regionLabel = (region: DeploymentRegion): string => region.toUpperCase();

export const regionFromIngestKey = (apiKey: string | undefined): DeploymentRegion | undefined => {
  if (!apiKey) return undefined;
  const marked = apiKey.match(/^ami_(us|eu)_/i)?.[1]?.toLowerCase();
  if (marked === "us" || marked === "eu") return marked;
  // Legacy unmarked keys remain US for backward compatibility.
  return /^ami_[a-z0-9]/i.test(apiKey) ? "us" : undefined;
};

export const regionFromArmatureUrl = (rawUrl: string | undefined): DeploymentRegion | undefined => {
  if (!rawUrl) return undefined;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    if (
      hostname === "eu.armature.tech"
      || hostname.endsWith(".eu.armature.tech")
    ) return "eu";
    if (hostname === "app.armature.tech" || hostname === "mcp.armature.tech") return "us";
  } catch {
    return undefined;
  }
  return undefined;
};

const regionalConfigurationCheck = (
  target: DoctorTarget,
  endpoint: string,
  apiKey: string | undefined,
): DoctorCheck => {
  const sources: Array<{ label: string; region: DeploymentRegion | undefined }> = [
    { label: "ingest key", region: regionFromIngestKey(apiKey) },
    { label: "ingest endpoint", region: regionFromArmatureUrl(endpoint) },
    {
      label: "MCP target",
      region: target.kind === "http" ? regionFromArmatureUrl(target.url) : undefined,
    },
  ];
  const recognized = sources.filter(
    (source): source is { label: string; region: DeploymentRegion } => source.region !== undefined,
  );
  const distinct = new Set(recognized.map((source) => source.region));
  if (distinct.size > 1) {
    return fail(
      "regional-configuration",
      "Regional configuration",
      recognized.map((source) => `${source.label} is ${regionLabel(source.region)}`).join(", ") + ".",
      "Use an ingest key, ingest endpoint, and MCP application URL from the same region. The doctor will not probe a mismatched endpoint.",
    );
  }
  if (recognized.length >= 2) {
    const region = recognized[0]?.region as DeploymentRegion;
    return pass(
      "regional-configuration",
      "Regional configuration",
      `${recognized.map((source) => source.label).join(" and ")} agree on ${regionLabel(region)}.`,
    );
  }
  return warn(
    "regional-configuration",
    "Regional configuration",
    recognized.length === 1
      ? `Only the ${recognized[0]?.label} identifies a known Armature region.`
      : "The key and URLs do not identify a known Armature region.",
    "For production, use an ami_us_ or ami_eu_ key and the matching regional Armature URLs.",
  );
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

// The SDK's own request_capability tool is registered without a telemetry
// block on purpose (its input is already conversation-derived), so the
// wrapping check must not count it as an unwrapped customer tool. Match on
// the exact advertised description as well as the reserved name so a
// customer-defined tool that merely shadows the name is still checked.
export const isSdkOwnedCapabilityTool = (tool: DoctorTool): boolean =>
  tool.name === REQUEST_CAPABILITY_TOOL_NAME
  && (tool.description || "") === REQUEST_CAPABILITY_DESCRIPTION;

export const inspectToolCoverage = (tools: DoctorTool[]) => {
  const current: string[] = [];
  const legacy: string[] = [];
  const owned: string[] = [];
  const missing: string[] = [];
  const sdkOwned: string[] = [];
  for (const tool of tools) {
    if (isSdkOwnedCapabilityTool(tool)) {
      sdkOwned.push(tool.name);
      continue;
    }
    const classification = classifyToolInstrumentation(tool);
    if (classification === "current") current.push(tool.name);
    else if (classification === "legacy") legacy.push(tool.name);
    else if (classification === "owned") owned.push(tool.name);
    else missing.push(tool.name);
  }
  return { current, legacy, owned, missing, sdkOwned, total: tools.length - sdkOwned.length };
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
    // Read the body so undici can release its pooled connection promptly (the
    // one-shot CLI must not appear to hang) and so we can surface an in-band
    // rejection — ingest answers 200 even when it refuses events (#1403). The
    // health probe sends an empty batch, so a rejection here signals the server
    // is refusing well-formed authenticated requests, not a per-event issue.
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Armature ingest returned HTTP ${response.status}`);
    }
    try {
      const parsed = JSON.parse(text || "{}") as { rejected?: unknown };
      if (Array.isArray(parsed.rejected) && parsed.rejected.length > 0) {
        const reasons = Array.from(
          new Set(
            parsed.rejected
              .map((item) => (isRecord(item) && typeof item.reason === "string" ? item.reason : null))
              .filter((reason): reason is string => Boolean(reason)),
          ),
        );
        throw new Error(
          `Armature ingest refused the health probe: ${parsed.rejected.length} event(s) rejected`
            + (reasons.length > 0 ? ` (${reasons.join(", ")})` : ""),
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Armature ingest refused")) throw error;
      // A non-JSON 200 body is not a rejection signal; reachability already passed.
    }
  } finally {
    clearTimeout(timer);
  }
};

// The tool-wrapping remediation must name the API of the SDK the doctor
// actually detected — telling a Go customer to "register tools inside
// withMcpAnalytics" (a TypeScript-only helper) sends them in circles,
// especially when they are already using an Armature recorder (the
// documented Go hooks-only shape: NewRecorder + WithHooks). `language`
// is the SDK detected by detectLocalSdks; undefined falls back to a
// cross-language phrasing.
const wrapApiFor = (language?: LocalSdk["language"]): string => {
  switch (language) {
    case "go":
      return "InstrumentTool / InstrumentToolWithConfig";
    case "python":
      return "instrument_fastmcp (or an Armature recorder)";
    case "typescript":
      return "withMcpAnalytics (or an Armature recorder)";
    default:
      return "the SDK's tool instrumentation (InstrumentTool / withMcpAnalytics / instrument_fastmcp)";
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
  // Remember the detected SDK so the wrapping check can phrase its fix in
  // that language's API (the first detected wins if several coexist).
  let detectedLanguage: LocalSdk["language"] | undefined;

  try {
    const sdks = await dependencies.detectLocalSdks(options.cwd);
    detectedLanguage = sdks[0]?.language;
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
          ? pass(
              "tool-wrapping",
              "Telemetry capture",
              "No Armature telemetry fields are advertised, as requested. "
                + `Tool-call and session analytics still flow; capturing user_intent/agent_thinking requires wrapping tools with ${wrapApiFor(detectedLanguage)}.`,
            )
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
          `Wrap the same server instance that is started, and register tools with ${wrapApiFor(detectedLanguage)}. `
            + "If this server intentionally uses hooks-only capture (an Armature recorder + hooks, no per-tool wrapping), tool-call and session analytics still flow — re-run with --capture off to treat unwrapped tools as expected and keep exit 0.",
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
          `All ${coverage.total} tools expose the current Armature telemetry contract.`
            + (coverage.sdkOwned.length > 0
              ? ` The SDK-owned ${coverage.sdkOwned.join(", ")} tool carries no telemetry block by design and is exempt.`
              : ""),
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

  const apiKey = environment.ANALYTICS_INGEST_API_KEY;
  const endpoint = environment.ANALYTICS_INGEST_URL || DEFAULT_INGEST_URL;
  const regionalCheck = regionalConfigurationCheck(options.target, endpoint, apiKey);
  checks.push(regionalCheck);

  if (options.skipIngest) {
    checks.push(warn(
      "ingest-auth",
      "Armature ingest",
      "Skipped by --skip-ingest; no network request was made.",
    ));
  } else {
    if (!apiKey) {
      checks.push(fail(
        "ingest-auth",
        "Armature ingest",
        "ANALYTICS_INGEST_API_KEY is not set in the doctor environment.",
        "Export the same ingest key used by the MCP server, then run the doctor again.",
      ));
    } else if (regionalCheck.status === "fail") {
      checks.push(fail(
        "ingest-auth",
        "Armature ingest",
        "Skipped the authenticated health probe because the regional configuration is inconsistent.",
        "Correct the regional mismatch, then run the doctor again.",
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
