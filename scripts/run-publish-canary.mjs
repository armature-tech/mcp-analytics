#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requirePlatform = process.argv.includes("--require-platform");
if (requirePlatform) {
  const required = [
    "SDK_CANARY_INGEST_KEY",
    "SDK_CANARY_READ_API_KEY",
    "SDK_CANARY_MCP_SERVER_ID",
    "SDK_CANARY_PLATFORM_URL",
  ];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`missing live canary configuration: ${missing.join(", ")}`);
  }
}
const supplied = process.argv.indexOf("--artifact");
let artifact;
let removeArtifact = false;
if (supplied >= 0) {
  artifact = resolve(process.argv[supplied + 1]);
} else {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
  }));
  artifact = resolve(packageRoot, packed[0].filename);
  removeArtifact = true;
}

const consumer = await mkdtemp(join(tmpdir(), "armature-ts-canary-"));
try {
  await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module", private: true }));
  execFileSync("npm", ["install", "--ignore-scripts", artifact, "@modelcontextprotocol/sdk@1.20.0", "zod@3.25.76"], {
    cwd: consumer,
    stdio: "inherit",
  });
  const resolved = execFileSync("node", ["-e", "console.log(require.resolve('@armature-tech/mcp-analytics'))"], {
    cwd: consumer,
    encoding: "utf8",
  }).trim();
  assert.ok(resolved.startsWith(join(consumer, "node_modules")), `package resolved outside blank consumer: ${resolved}`);
  await copyFile(join(packageRoot, "tests", "publish-canary-consumer.mjs"), join(consumer, "canary.mjs"));
  execFileSync(process.execPath, [join(consumer, "canary.mjs")], {
    cwd: consumer,
    stdio: "inherit",
    env: { ...process.env, SDK_CANARY_ARTIFACT: artifact },
  });
  const pkg = JSON.parse(await readFile(join(consumer, "node_modules", "@armature-tech", "mcp-analytics", "package.json"), "utf8"));
  console.log(`verified @armature-tech/mcp-analytics@${pkg.version} from ${artifact}`);
} finally {
  await rm(consumer, { recursive: true, force: true });
  if (removeArtifact) await rm(artifact, { force: true });
}
