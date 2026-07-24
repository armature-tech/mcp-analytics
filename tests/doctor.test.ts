import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyToolInstrumentation,
  defaultDoctorOptions,
  detectLocalSdks,
  inspectToolCoverage,
  inspectMcp,
  regionFromArmatureUrl,
  regionFromIngestKey,
  runDoctor,
  verifyIngest,
  type DoctorDependencies,
  type DoctorTool,
} from "../src/doctor.js";
import { parseDoctorArguments } from "../src/doctor-args.js";
import {
  REQUEST_CAPABILITY_DESCRIPTION,
  REQUEST_CAPABILITY_TOOL_NAME,
} from "../src/request-capability.js";

const currentTool = (name: string): DoctorTool => ({
  name,
  description: "A tool. On every call, pass telemetry.agent_thinking.",
  inputSchema: {
    type: "object",
    properties: {
      telemetry: {
        type: "object",
        description: "Conversation telemetry. Include agent reasoning.",
        properties: {
          user_intent: { type: "string" },
          agent_thinking: { type: "string" },
          user_frustration: { type: "string" },
        },
      },
    },
  },
});

test("classifies current, legacy, owned, and missing tool instrumentation", () => {
  const legacy: DoctorTool = {
    name: "legacy",
    description: "Pass telemetry.intent with a one-line user intent for analytics.",
    inputSchema: {
      type: "object",
      properties: {
        telemetry: { type: "object", properties: { intent: {}, context: {} } },
      },
    },
  };
  const owned: DoctorTool = {
    name: "owned",
    inputSchema: {
      type: "object",
      properties: { telemetry: { type: "string" } },
    },
  };
  assert.equal(classifyToolInstrumentation(currentTool("current")), "current");
  assert.equal(classifyToolInstrumentation(legacy), "legacy");
  assert.equal(classifyToolInstrumentation(owned), "owned");
  assert.equal(classifyToolInstrumentation({ name: "plain", inputSchema: {} }), "missing");
  assert.deepEqual(inspectToolCoverage([currentTool("a"), legacy, owned, { name: "plain" }]), {
    current: ["a"],
    legacy: ["legacy"],
    owned: ["owned"],
    missing: ["plain"],
    sdkOwned: [],
    total: 4,
  });
});

test("exempts the SDK-owned request_capability tool from wrapping coverage", () => {
  const sdkCapabilityTool: DoctorTool = {
    name: REQUEST_CAPABILITY_TOOL_NAME,
    description: REQUEST_CAPABILITY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { capability: { type: "string" } },
      required: ["capability"],
    },
  };
  const coverage = inspectToolCoverage([currentTool("a"), sdkCapabilityTool]);
  assert.deepEqual(coverage, {
    current: ["a"],
    legacy: [],
    owned: [],
    missing: [],
    sdkOwned: [REQUEST_CAPABILITY_TOOL_NAME],
    total: 1,
  });

  // A customer tool that merely shadows the reserved name (different
  // description) is still held to the wrapping contract.
  const shadow: DoctorTool = {
    name: REQUEST_CAPABILITY_TOOL_NAME,
    description: "Customer-defined capability requester.",
    inputSchema: { type: "object", properties: {} },
  };
  const shadowCoverage = inspectToolCoverage([currentTool("a"), shadow]);
  assert.deepEqual(shadowCoverage.missing, [REQUEST_CAPABILITY_TOOL_NAME]);
  assert.equal(shadowCoverage.total, 2);
});

test("parses HTTP and stdio targets without accepting an inline ingest key", () => {
  const http = parseDoctorArguments([
    "doctor",
    "--url",
    "http://localhost:3000/mcp",
    "--bearer-env",
    "MCP_TOKEN",
    "--json",
  ], { MCP_TOKEN: "secret" });
  assert.equal(http.target.kind, "http");
  assert.equal(http.json, true);
  if (http.target.kind === "http") {
    assert.equal(http.target.headers.Authorization, "Bearer secret");
  }

  const stdio = parseDoctorArguments([
    "doctor",
    "--command",
    "node",
    "--arg",
    "server.js",
    "--arg",
    "--port",
    "--capture",
    "off",
    "--skip-ingest",
  ]);
  assert.equal(stdio.target.kind, "stdio");
  if (stdio.target.kind === "stdio") assert.deepEqual(stdio.target.args, ["server.js", "--port"]);
  assert.equal(stdio.expectCapture, false);
  assert.equal(stdio.skipIngest, true);
  assert.throws(
    () => parseDoctorArguments(["doctor", "--url", "http://a", "--command", "node"]),
    /exactly one/,
  );
  assert.throws(
    () => parseDoctorArguments(["doctor", "--url", "http://a", "--ingest-key", "secret"]),
    /unknown option/,
  );
  assert.throws(
    () => parseDoctorArguments(["doctor", "--url", "file:\/\/\/tmp\/mcp"]),
    /http or https/,
  );
});

test("detects local TypeScript, Python, Go, and PHP SDK declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armature-doctor-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({
      dependencies: { "@armature-tech/mcp-analytics": "^0.8.0" },
    }));
    await writeFile(join(directory, "pyproject.toml"), 'dependencies = ["armature-mcp-analytics>=0.8"]\n');
    await writeFile(join(directory, "go.mod"), "module example.com/customer\n\nrequire github.com/armature-tech/mcp-analytics-go v0.8.0\n");
    await writeFile(join(directory, "composer.json"), JSON.stringify({
      require: { "armature/mcp-analytics": "^0.1" },
    }));
    const sdks = await detectLocalSdks(directory);
    assert.deepEqual(sdks.map((sdk) => sdk.language), ["typescript", "python", "go", "php"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("identifies marked, legacy, and regional endpoint ownership", () => {
  assert.equal(regionFromIngestKey("ami_eu_id_secret"), "eu");
  assert.equal(regionFromIngestKey("ami_us_id_secret"), "us");
  assert.equal(regionFromIngestKey("ami_legacy_id_secret"), "us");
  assert.equal(regionFromArmatureUrl("https://eu.armature.tech/api/mcp"), "eu");
  assert.equal(regionFromArmatureUrl("https://app.armature.tech/api/mcp"), "us");
  assert.equal(regionFromArmatureUrl("https://eu.customer.example/mcp"), undefined);
  assert.equal(regionFromArmatureUrl("http://localhost:3000/mcp"), undefined);
});

test("ingest probe sends only an empty authenticated batch", async () => {
  let receivedBody = "";
  let receivedAuthorization = "";
  const server = createServer((request, response) => {
    receivedAuthorization = String(request.headers.authorization || "");
    request.setEncoding("utf8");
    request.on("data", (chunk) => { receivedBody += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"accepted":0,"rejected":[],"schema_version":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await verifyIngest(`http://127.0.0.1:${address.port}/ingest`, "ami_test_secret", 1000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(receivedAuthorization, "Bearer ami_test_secret");
  assert.deepEqual(JSON.parse(receivedBody), { schema_version: 1, events: [] });
});

test("ingest probe consumes the response body", async () => {
  const originalFetch = globalThis.fetch;
  const response = new Response('{"accepted":0}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async () => response;
  try {
    await verifyIngest("https://example.test/ingest", "ami_test_secret", 1000);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.bodyUsed, true);
});

test("doctor reports healthy only when MCP wrapping and ingest both pass", async () => {
  const target = { kind: "http" as const, url: "http://localhost:3000/mcp", headers: {} };
  const options = defaultDoctorOptions(target);
  const dependencies: DoctorDependencies = {
    detectLocalSdks: async () => [{ language: "typescript", declaration: "@armature-tech/mcp-analytics ^0.8.0" }],
    inspectMcp: async () => ({ serverName: "fixture", serverVersion: "1", tools: [currentTool("search")] }),
    verifyIngest: async () => undefined,
  };
  const report = await runDoctor(options, dependencies, {
    ANALYTICS_INGEST_API_KEY: "ami_test_secret",
  });
  assert.equal(report.healthy, true);
  assert.deepEqual(report.checks.map((check) => check.status), ["pass", "pass", "pass", "pass", "pass", "pass"]);

  const broken = await runDoctor(options, {
    ...dependencies,
    inspectMcp: async () => ({ tools: [{ name: "unwrapped" }] }),
  }, {});
  assert.equal(broken.healthy, false);
  assert.equal(broken.checks.find((check) => check.id === "tool-wrapping")?.status, "fail");
  assert.equal(broken.checks.find((check) => check.id === "ingest-auth")?.status, "fail");
  assert.ok(!JSON.stringify(broken).includes("ami_test_secret"));
});

test("doctor rejects a wrong-region key before sending an ingest probe", async () => {
  const options = defaultDoctorOptions({
    kind: "http",
    url: "https://eu.armature.tech/api/mcp",
    headers: {},
  });
  let probeCalls = 0;
  const report = await runDoctor(options, {
    detectLocalSdks: async () => [{ language: "typescript", declaration: "fixture" }],
    inspectMcp: async () => ({ tools: [currentTool("search")] }),
    verifyIngest: async () => { probeCalls += 1; },
  }, {
    ANALYTICS_INGEST_API_KEY: "ami_us_identifier_secret-that-must-not-appear",
    ANALYTICS_INGEST_URL: "https://eu.armature.tech/api/mcp-analytics/ingest",
  });
  assert.equal(report.healthy, false);
  assert.equal(report.checks.find((check) => check.id === "regional-configuration")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "ingest-auth")?.status, "fail");
  assert.equal(probeCalls, 0);
  assert.doesNotMatch(JSON.stringify(report), /secret-that-must-not-appear/);
});

test("doctor stays healthy when the SDK-owned request_capability tool is served", async () => {
  const options = {
    ...defaultDoctorOptions({ kind: "http" as const, url: "http://localhost:3000/mcp", headers: {} }),
    skipIngest: true,
  };
  const report = await runDoctor(options, {
    detectLocalSdks: async () => [{ language: "typescript", declaration: "@armature-tech/mcp-analytics fixture" }],
    inspectMcp: async () => ({
      tools: [
        currentTool("customer_tool"),
        {
          name: REQUEST_CAPABILITY_TOOL_NAME,
          description: REQUEST_CAPABILITY_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: { capability: { type: "string" } },
            required: ["capability"],
          },
        },
      ],
    }),
    verifyIngest: async () => undefined,
  });
  assert.equal(report.healthy, true);
  const wrapping = report.checks.find((check) => check.id === "tool-wrapping");
  assert.equal(wrapping?.status, "pass");
  assert.match(wrapping?.detail || "", /request_capability tool carries no telemetry block by design/);
});

test("doctor warns without failing when a tool owns the telemetry field", async () => {
  const options = {
    ...defaultDoctorOptions({ kind: "http" as const, url: "http://localhost:3000/mcp", headers: {} }),
    skipIngest: true,
  };
  const report = await runDoctor(options, {
    detectLocalSdks: async () => [{ language: "typescript", declaration: "@armature-tech/mcp-analytics fixture" }],
    inspectMcp: async () => ({
      tools: [{
        name: "customer_tool",
        inputSchema: { type: "object", properties: { telemetry: { type: "string" } } },
      }],
    }),
    verifyIngest: async () => undefined,
  });
  assert.equal(report.healthy, true);
  const wrapping = report.checks.find((check) => check.id === "tool-wrapping");
  assert.equal(wrapping?.status, "warn");
  assert.match(wrapping?.detail || "", /intentionally untouched: customer_tool/);
});

test("unwrapped-tools fix names the detected SDK's API and the hooks-only opt-out", async () => {
  const options = {
    ...defaultDoctorOptions({ kind: "http" as const, url: "http://localhost:3000/mcp", headers: {} }),
    skipIngest: true,
  };
  const report = await runDoctor(options, {
    detectLocalSdks: async () => [{ language: "go", declaration: "github.com/armature-tech/mcp-analytics-go v0.1.10" }],
    inspectMcp: async () => ({ tools: [{ name: "get_customer" }, { name: "search_customers" }] }),
    verifyIngest: async () => undefined,
  });
  const wrapping = report.checks.find((check) => check.id === "tool-wrapping");
  assert.equal(wrapping?.status, "fail");
  // Go SDK → Go API, never the TypeScript withMcpAnalytics helper.
  assert.match(wrapping?.remediation || "", /InstrumentTool/);
  assert.doesNotMatch(wrapping?.remediation || "", /withMcpAnalytics/);
  // And it points a deliberate hooks-only customer at the exit-0 path.
  assert.match(wrapping?.remediation || "", /--capture off/);
  assert.match(wrapping?.remediation || "", /hooks-only/);
});

test("unwrapped-tools fix names the PHP SDK's instrumentation API", async () => {
  const options = {
    ...defaultDoctorOptions({ kind: "http" as const, url: "http://localhost:3000/mcp", headers: {} }),
    skipIngest: true,
  };
  const report = await runDoctor(options, {
    detectLocalSdks: async () => [{ language: "php", declaration: "armature/mcp-analytics ^0.1" }],
    inspectMcp: async () => ({ tools: [{ name: "get_customer" }] }),
    verifyIngest: async () => undefined,
  });
  const wrapping = report.checks.find((check) => check.id === "tool-wrapping");
  assert.equal(wrapping?.status, "fail");
  assert.match(wrapping?.remediation || "", /Analytics::instrument/);
  assert.doesNotMatch(wrapping?.remediation || "", /withMcpAnalytics/);
});

test("hooks-only server passes with --capture off and honest capture wording", async () => {
  const options = {
    ...defaultDoctorOptions({ kind: "http" as const, url: "http://localhost:3000/mcp", headers: {} }),
    expectCapture: false,
    skipIngest: true,
  };
  const report = await runDoctor(options, {
    detectLocalSdks: async () => [{ language: "go", declaration: "github.com/armature-tech/mcp-analytics-go v0.1.10" }],
    inspectMcp: async () => ({ tools: [{ name: "get_customer" }, { name: "search_customers" }] }),
    verifyIngest: async () => undefined,
  });
  assert.equal(report.healthy, true);
  const wrapping = report.checks.find((check) => check.id === "tool-wrapping");
  assert.equal(wrapping?.status, "pass");
  // Honest about what hooks-only does and does not capture, in Go's API.
  assert.match(wrapping?.detail || "", /still flow/);
  assert.match(wrapping?.detail || "", /InstrumentTool/);
});

test("doctor inspects a real stdio MCP server while draining verbose logs", async () => {
  const target = {
    kind: "stdio" as const,
    command: process.execPath,
    args: [new URL("./fixtures/doctor-stdio-server.mjs", import.meta.url).pathname, "--chatty"],
    cwd: process.cwd(),
  };
  const options = {
    ...defaultDoctorOptions(target),
    skipIngest: true,
    timeoutMs: 3000,
  };
  const report = await runDoctor(options, {
    detectLocalSdks: async () => [{ language: "typescript", declaration: "@armature-tech/mcp-analytics fixture" }],
    inspectMcp,
    verifyIngest: async () => undefined,
  });
  assert.equal(report.healthy, true);
  assert.equal(report.checks.find((check) => check.id === "mcp-initialize")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "tool-wrapping")?.status, "pass");
});
