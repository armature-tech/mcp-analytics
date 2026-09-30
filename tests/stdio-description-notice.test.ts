import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/stdio-long-description-server.ts", import.meta.url),
);

// A stdio server's stdout carries JSON-RPC, so the description-length notice
// must reach stderr at every level; on stdout the client reports "is not
// valid JSON".
for (const level of ["warning", "info", "debug"] as const) {
  test(`stdio: a ${level} description-length notice stays off the JSON-RPC stream`, async () => {
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
      assert.equal(tools[0]?.name, "long_tool");
      assert.deepEqual(errors.map((error) => error.message), []);
      assert.match(stderr, /\[mcp-analytics\] Tool "long_tool" description is too long/);
    } finally {
      await client.close();
    }
  });
}
