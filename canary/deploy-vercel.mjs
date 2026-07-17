#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
};
const artifact = resolve(arg("--artifact"));
const marker = arg("--marker");
const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const token = process.env.VERCEL_TOKEN;
const authArgs = token ? [`--token=${token}`] : [];
const orgId = required("VERCEL_ORG_ID");
const scope = required("VERCEL_SCOPE");
const projectId = required("SDK_CANARY_VERCEL_PROJECT_ID");
const stableUrl = required("SDK_CANARY_MCP_URL").replace(/\/$/, "");
const ingestKey = required("SDK_CANARY_INGEST_KEY");
const platformUrl = required("SDK_CANARY_PLATFORM_URL").replace(/\/$/, "");
const vercelCommand = process.env.VERCEL_CLI_JS ? process.execPath : "vercel";
const vercelPrefix = process.env.VERCEL_CLI_JS ? [process.env.VERCEL_CLI_JS] : [];

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || `exit ${result.status}`}`);
  return result.stdout || "";
};
const runVercel = (args, options = {}) => run(vercelCommand, [...vercelPrefix, ...args], {
  ...options,
  env: { ...process.env, VERCEL_PROJECT_ID: projectId, ...(options.env || {}) },
});

const project = await mkdtemp(join(tmpdir(), "sdk-canary-ts-vercel-"));
try {
  await cp(join(root, "canary", "vercel"), project, { recursive: true });
  await mkdir(join(project, "vendor"), { recursive: true });
  await cp(artifact, join(project, "vendor", "candidate.tgz"));
  await mkdir(join(project, ".vercel"), { recursive: true });
  await writeFile(join(project, ".vercel", "project.json"), `${JSON.stringify({ orgId, projectId }, null, 2)}\n`);
  const envArgs = [
    "--env", `SDK_CANARY_INGEST_KEY=${ingestKey}`,
    "--env", `SDK_CANARY_PLATFORM_URL=${platformUrl}`,
    "--env", `SDK_CANARY_DEPLOYMENT=${marker}`,
  ];
  // The candidate tarball keeps a stable file: dependency path. Bypass the
  // Vercel build cache so a new tarball can never reuse an older SDK install.
  const output = runVercel(["deploy", "--prod", "--skip-domain", "--force", "--yes", "--scope", scope, ...authArgs, ...envArgs], { cwd: project, capture: true });
  const previewUrl = output.match(/https:\/\/[A-Za-z0-9.-]+\.vercel\.app/g)?.at(-1);
  assert.ok(previewUrl, "Vercel deploy did not return a deployment URL");
  run(process.execPath, [join(root, "canary", "mcp-http-smoke.mjs"), "--url", `${previewUrl}/mcp`, "--intent", `${marker}/protocol-preview`, "--deployment", marker]);
  runVercel(["promote", previewUrl, "--yes", "--timeout", "5m", "--scope", scope, ...authArgs], { cwd: project });
  run(process.execPath, [join(root, "canary", "mcp-http-smoke.mjs"), "--url", stableUrl, "--intent", `${marker}/protocol-stable`, "--deployment", marker]);
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `deployment_url=${previewUrl}\nstable_url=${stableUrl}\n`, { flag: "a" });
  console.log(`promoted ${previewUrl} to ${stableUrl}`);
} finally {
  await rm(project, { recursive: true, force: true });
}
