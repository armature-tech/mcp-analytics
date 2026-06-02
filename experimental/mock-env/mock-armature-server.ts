import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type TelemetryPayload = Record<string, unknown>;

export type StoredTelemetryPayload = {
  id: number;
  received_at: string;
  payload: TelemetryPayload;
};

export type MockArmatureServerOptions = {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const telemetry: StoredTelemetryPayload[] = [];

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body, null, 2));
};

const readJsonBody = async (
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;

    if (size > maxBodyBytes) {
      throw new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const isTelemetryPayload = (value: unknown): value is TelemetryPayload => {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
};

export const createMockArmatureServer = (
  options: MockArmatureServerOptions = {},
) => {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? DEFAULT_HOST}`,
    );

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/telemetry") {
      sendJson(response, 200, { telemetry });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/telemetry") {
      telemetry.length = 0;
      sendJson(response, 200, { telemetry });
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/telemetry" ||
        url.pathname === "/api/mcp-analytics/ingest")
    ) {
      try {
        const payload = await readJsonBody(request, maxBodyBytes);

        if (!isTelemetryPayload(payload)) {
          sendJson(response, 400, {
            error: "Telemetry payload must be a JSON object.",
          });
          return;
        }

        const entry = {
          id: telemetry.length + 1,
          received_at: new Date().toISOString(),
          payload,
        };
        telemetry.push(entry);

        sendJson(response, 202, entry);
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid JSON body.",
        });
      }
      return;
    }

    sendJson(response, 404, {
      error: "Not found.",
      endpoints: [
        "GET /health",
        "POST /api/mcp-analytics/ingest",
        "POST /telemetry",
        "GET /telemetry",
        "DELETE /telemetry",
      ],
    });
  });
};

export const main = async () => {
  const host = process.env.ARMATURE_MOCK_HOST ?? DEFAULT_HOST;
  const port = Number(process.env.ARMATURE_MOCK_PORT ?? DEFAULT_PORT);
  const server = createMockArmatureServer();

  server.listen(port, host, () => {
    console.log(`Mock Armature server listening on http://${host}:${port}`);
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
