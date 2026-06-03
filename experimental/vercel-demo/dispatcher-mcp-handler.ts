import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createDispatcherDemo,
  type DispatcherRequestContext,
} from "./dispatcher-mcp-server.js";

const demo = createDispatcherDemo();

type VercelLikeRequest = IncomingMessage & { body?: unknown };

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

const readJsonBody = async (request: VercelLikeRequest): Promise<unknown> => {
  if (request.body !== undefined) return request.body;
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
};

const firstHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const parseContext = (request: IncomingMessage): DispatcherRequestContext => {
  const auth = firstHeader(request, "authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const [organizationId, userProfileId] = (bearer || "demo-org:demo-user").split(":");
  return {
    sessionId: firstHeader(request, "mcp-session-id") ?? randomUUID(),
    organizationId: organizationId || "demo-org",
    userProfileId: userProfileId || "demo-user",
  };
};

const buildResult = (id: JsonRpcRequest["id"], result: unknown) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  result,
});

const buildError = (
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

const dispatchPayload = async (
  payload: JsonRpcRequest,
  ctx: DispatcherRequestContext,
) => {
  if (payload.method === "initialize") {
    await demo.recordSessionInit(ctx);
    return buildResult(payload.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: {
        name: "experimental-vercel-mcp-dispatcher-demo",
        version: "0.1.0",
      },
    });
  }
  if (payload.method === "tools/list") {
    return buildResult(payload.id, { tools: demo.listTools() });
  }
  if (payload.method === "tools/call") {
    const params = (payload.params ?? {}) as {
      name?: string;
      arguments?: unknown;
    };
    if (!params.name) {
      return buildError(payload.id, -32602, "Missing tool name");
    }
    try {
      const result = await demo.callTool(params.name, params.arguments ?? {}, ctx);
      return buildResult(payload.id, result);
    } catch (error) {
      return buildError(
        payload.id,
        -32000,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return buildError(payload.id, -32601, `Unknown method: ${payload.method}`);
};

const setCorsHeaders = (response: ServerResponse) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    ["content-type", "authorization", "mcp-session-id"].join(", "),
  );
};

export default async function handler(
  request: VercelLikeRequest,
  response: ServerResponse,
) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== "POST") {
    response.statusCode = 405;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  try {
    const body = (await readJsonBody(request)) as JsonRpcRequest | JsonRpcRequest[];
    const ctx = parseContext(request);
    const reply = Array.isArray(body)
      ? await Promise.all(body.map((payload) => dispatchPayload(payload, ctx)))
      : await dispatchPayload(body, ctx);

    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reply));
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
      }),
    );
  }
}
