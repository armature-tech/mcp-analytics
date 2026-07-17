#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import {
  collectSessionEvidence,
  formatSessionEvidence,
  harnessFamily,
  selectExpectedHarnessEvidence,
  withExpectedHarnesses,
} from "./session-evidence.mjs";

const arg = name => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
};
const packageName = arg("--package");
const marker = arg("--marker");
const required = name => {
  if (!process.env[name]) throw new Error(`missing ${name}`);
  return process.env[name];
};
const base = required("SDK_CANARY_PLATFORM_URL").replace(/\/$/, "");
const readKey = required("SDK_CANARY_READ_API_KEY");
const dispatchSecret = required("SDK_CANARY_DISPATCH_SECRET");
const serverId = required("SDK_CANARY_MCP_SERVER_ID");

const dispatchResponse = await fetch(`${base}/api/internal/sdk-canary-dispatch`, {
  method: "POST",
  headers: { authorization: `Bearer ${dispatchSecret}`, "content-type": "application/json" },
  body: JSON.stringify({ package: packageName, marker }),
});
assert.ok(dispatchResponse.ok, `harness dispatch failed: HTTP ${dispatchResponse.status}`);
const dispatch = withExpectedHarnesses(await dispatchResponse.json());
assert.equal(dispatch.runs.length, 4);
assert.equal(new Set(dispatch.runs.map(run => run.runId)).size, 4);
const dispatchTargetCounts = new Map();
for (const run of dispatch.runs) dispatchTargetCounts.set(run.modelId, (dispatchTargetCounts.get(run.modelId) || 0) + 1);
assert.deepEqual([...dispatchTargetCounts.values()].sort(), [2, 2], "dispatch did not create two runs per harness model");

const headers = { authorization: `Bearer ${readKey}` };
const deadline = Date.now() + 12 * 60_000;
let matches = [];
let settledFingerprint = "";
let stableSince = 0;
while (Date.now() < deadline) {
  const url = new URL("/api/armature/v1/insights/sessions", base);
  url.searchParams.set("range", "24h");
  url.searchParams.set("intent", marker);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers });
  assert.ok(response.ok, `session readback failed: HTTP ${response.status}`);
  const body = await response.json();
  matches = body.sessions.filter(session => session.raw_intent === marker && session.mcp_server_id === serverId && session.event_count > 0);
  const fingerprint = matches
    .map(session => `${session.id}:${session.event_count}:${session.error_count}`)
    .sort()
    .join("|");
  if (matches.length >= 4 && fingerprint === settledFingerprint && Date.now() - stableSince >= 30_000) break;
  if (fingerprint !== settledFingerprint) {
    settledFingerprint = fingerprint;
    stableSince = matches.length >= 4 ? Date.now() : 0;
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
const evidence = await collectSessionEvidence({ base, headers, matches, dispatch });
const evidenceTable = formatSessionEvidence({ packageName, base, dispatch, evidence });
console.log(evidenceTable);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${evidenceTable}\n`);

for (const { session, workflowRunIds, run } of evidence) {
  assert.equal(workflowRunIds.length, 1, `${session.id}: expected exactly one workflow correlation, got ${workflowRunIds.join(", ") || "none"}`);
  assert.ok(run, `${session.id}: session did not correlate to a dispatched workflow run`);
}
assert.ok(matches.length >= 4, `expected at least four harness sessions, got ${matches.length}`);
assert.equal(new Set(matches.map(session => session.session_key)).size, matches.length, "harness sessions were merged");
const expectedEvidence = selectExpectedHarnessEvidence({ dispatch, evidence });
const expectedSessions = expectedEvidence.map(item => item.session);
assert.equal(new Set(expectedSessions.map(session => session.session_key)).size, 4, "expected harness sessions were merged");
assert.equal(new Set(expectedSessions.map(session => session.actor_id)).size, 1, "canary sessions did not use the shared actor seed");
assert.deepEqual(
  expectedSessions.map(harnessFamily).sort(),
  ["claude_code", "claude_code", "codex", "codex"],
  `expected two Claude Code and two Codex sessions, got ${expectedSessions.map(session => session.client_name || "unknown").join(", ")}`,
);

for (const { session } of evidence) {
  assert.ok(session.event_count > 0, `${session.id}: session was empty`);
  assert.equal(session.error_count, 0, `${session.id}: canary tool call failed`);
}
if (matches.length > expectedSessions.length) {
  console.log(`observed ${matches.length - expectedSessions.length} correlated fallback harness session(s)`);
}

console.log(`verified four isolated Claude Code/Codex sessions for ${packageName}: ${dispatch.runs.map(run => run.runId).join(", ")}`);
