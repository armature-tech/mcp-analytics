import type { IncomingMessage, ServerResponse } from "node:http";

type VercelLikeResponse = ServerResponse & {
  status?: (statusCode: number) => {
    json?: (payload: unknown) => void;
  };
  json?: (payload: unknown) => void;
};

const sendJson = (
  response: VercelLikeResponse,
  statusCode: number,
  payload: unknown,
) => {
  if (typeof response.status === "function") {
    const statusResponse = response.status(statusCode);
    if (statusResponse && typeof statusResponse.json === "function") {
      statusResponse.json(payload);
      return;
    }
  }

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
};

export default function handler(
  request: IncomingMessage,
  response: VercelLikeResponse,
) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    service: "experimental-vercel-mcp-demo",
    version: "0.1.0",
    instrumented_with: "@armature/mcp-analytics",
    timestamp: new Date().toISOString(),
  });
}
