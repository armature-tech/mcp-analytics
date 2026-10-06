import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_TOOL_DESCRIPTION_LENGTH } from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/stdio-long-description-server.ts", import.meta.url),
);
// Same text as the fixture registers; the fixture runs in a child process.
const LONG_DESCRIPTION = "z".repeat(2000);

// The SDK no longer adds text to tool descriptions, so there is no
// description-length notice: descriptionLengthLogLevel is accepted and
// ignored. A stdio server's stdout carries JSON-RPC (anything else makes the
// client report "is not valid JSON"), and nothing about descriptions reaches
// stderr either, at any level.
for (const level of ["warning", "info", "debug", "none"] as const) {
  test(`stdio: a long description passes through unchanged and logs nothing (descriptionLengthLogLevel ${level})`, async () => {
    assert.ok(LONG_DESCRIPTION.length > MAX_TOOL_DESCRIPTION_LENGTH);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fixturePath],
      cwd: packageRoot,
      env: { ...getDefaultEnvironment(), DESCRIPTION_LENGTH_LOG_LEVEL: level },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: "notice-check", version: "0.0.1" });
    const errors: Error[] = [];
    client.onerror = (error) => { errors.push(error); };
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const longTool = tools.find((tool) => tool.name === "long_tool");
      assert.ok(longTool);
      assert.equal(longTool.description, LONG_DESCRIPTION);
      const result = await client.callTool({ name: "long_tool", arguments: {} });
      assert.equal((result.content as { text?: string }[])[0]?.text, "ok");
      assert.deepEqual(errors.map((error) => error.message), []);
      assert.doesNotMatch(stderr, /mcp-analytics|description/i);
    } finally {
      await client.close();
    }
  });
}
