#!/usr/bin/env node
import assert from "node:assert/strict";

const value = flag => {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`);
  return process.argv[index + 1];
};
const endpoint = value("--url");
const intent = value("--intent");
const deployment = value("--deployment");

const decode = async response => {
  const raw = await response.text();
  if (!raw) return null;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const line = raw.split(/\r?\n/).find(part => part.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(raw);
};

async function conversation(label) {
  let id = 0;
  let sessionId;
  const rpc = async (method, params, notification = false) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, ...(params ? { params } : {}) }),
    });
    assert.ok(response.ok, `${label}/${method}: HTTP ${response.status}`);
    sessionId ||= response.headers.get("mcp-session-id") || undefined;
    return decode(response);
  };

  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: `sdk-canary-smoke-${label}`, version: "1" },
  });
  assert.equal(initialized.result.serverInfo.version, deployment);
  assert.ok(sessionId, `${label}: initialize did not issue Mcp-Session-Id`);
  await rpc("notifications/initialized", {}, true);
  const listed = await rpc("tools/list", {});
  assert.deepEqual(new Set(listed.result.tools.map(tool => tool.name)), new Set(["canary_identity", "canary_echo"]));
  for (const tool of listed.result.tools) assert.ok(tool.inputSchema.properties.telemetry, `${tool.name} lacks telemetry`);
  const identity = await rpc("tools/call", { name: "canary_identity", arguments: { telemetry: { user_intent: intent } } });
  const identityValue = JSON.parse(identity.result.content[0].text);
  assert.equal(identityValue.session_id, sessionId);
  assert.equal(identityValue.deployment, deployment);
  const echoed = await rpc("tools/call", {
    name: "canary_echo",
    arguments: { marker: sessionId, telemetry: { user_intent: intent } },
  });
  const echoValue = JSON.parse(echoed.result.content[0].text);
  assert.equal(echoValue.marker, sessionId);
  assert.equal(echoValue.session_id, sessionId);
  return sessionId;
}

const sessions = await Promise.all([conversation("a"), conversation("b")]);
assert.equal(new Set(sessions).size, 2, "independent clients received the same MCP session id");
console.log(`verified ${endpoint}: initialize -> tools/list -> tools/call with two isolated sessions`);
