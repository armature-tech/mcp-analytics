import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSessionId } from "../src/index.js";

test("explicit event.sessionId wins over extra.sessionId and header", () => {
  const result = normalizeSessionId("event-session", {
    sessionId: "extra-session",
    requestInfo: { headers: { "mcp-session-id": "header-session" } },
  });
  assert.equal(result, "event-session");
});

test("extra.sessionId wins over header when event.sessionId is absent", () => {
  const result = normalizeSessionId(undefined, {
    sessionId: "extra-session",
    requestInfo: { headers: { "mcp-session-id": "header-session" } },
  });
  assert.equal(result, "extra-session");
});

test("falls back to header on a plain lowercased object", () => {
  const result = normalizeSessionId(undefined, {
    requestInfo: { headers: { "mcp-session-id": "abc" } },
  });
  assert.equal(result, "abc");
});

test("falls back to header on a Headers instance", () => {
  const headers = new Headers({ "mcp-session-id": "abc" });
  const result = normalizeSessionId(undefined, {
    requestInfo: { headers },
  });
  assert.equal(result, "abc");
});

test("mixed-case header key still resolves", () => {
  const result = normalizeSessionId(undefined, {
    requestInfo: { headers: { "Mcp-Session-Id": "abc" } },
  });
  assert.equal(result, "abc");
});

test("empty / whitespace-only header value falls through to undefined", () => {
  assert.equal(
    normalizeSessionId(undefined, {
      requestInfo: { headers: { "mcp-session-id": "" } },
    }),
    undefined,
  );
  assert.equal(
    normalizeSessionId(undefined, {
      requestInfo: { headers: { "mcp-session-id": "   " } },
    }),
    undefined,
  );
  assert.equal(
    normalizeSessionId(undefined, {
      requestInfo: { headers: new Headers({ "mcp-session-id": "" }) },
    }),
    undefined,
  );
});

test("array-valued header (Node IncomingHttpHeaders shape) picks the first entry", () => {
  const result = normalizeSessionId(undefined, {
    requestInfo: { headers: { "mcp-session-id": ["abc", "def"] } },
  });
  assert.equal(result, "abc");
});

test("returns undefined when no sessionId source is available", () => {
  assert.equal(normalizeSessionId(undefined, undefined), undefined);
  assert.equal(normalizeSessionId(undefined, {}), undefined);
  assert.equal(
    normalizeSessionId(undefined, { requestInfo: { headers: {} } }),
    undefined,
  );
});

test("trims surrounding whitespace from a valid header value", () => {
  const result = normalizeSessionId(undefined, {
    requestInfo: { headers: { "mcp-session-id": "  abc  " } },
  });
  assert.equal(result, "abc");
});
