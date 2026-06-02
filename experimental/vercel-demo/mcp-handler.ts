import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createInstrumentedDemoMcpServer } from "./demo-mcp-server.js";

type VercelLikeRequest = IncomingMessage & {
  body?: unknown;
};

type VercelLikeResponse = ServerResponse & {
  status?: (statusCode: number) => {
    json?: (payload: unknown) => void;
  };
  json?: (payload: unknown) => void;
};

const setCorsHeaders = (response: ServerResponse) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    ["content-type", "mcp-session-id", "x-requested-with"].join(", "),
  );
  response.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
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

const handleMcpRequest = async (
  request: VercelLikeRequest,
  response: ServerResponse,
) => {
  const { server } = createInstrumentedDemoMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  response.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
};

export default async function handler(
  request: VercelLikeRequest,
  response: VercelLikeResponse,
) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  try {
    await handleMcpRequest(request, response);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: null,
      });
      return;
    }
    response.end();
  }
}
