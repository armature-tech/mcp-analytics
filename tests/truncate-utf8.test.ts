import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateUtf8 } from "../src/utils.js";

const REPLACEMENT = "�";

test("stays within maxBytes when the limit falls inside a multi-byte character", () => {
  // "€" is 3 bytes (E2 82 AC). A 4-byte limit lands one byte into the second "€".
  const { value, truncated } = truncateUtf8("€€€€", 4);
  assert.equal(truncated, true);
  assert.ok(
    Buffer.byteLength(value, "utf8") <= 4,
    `result is ${Buffer.byteLength(value, "utf8")} bytes, must be <= 4`,
  );
  assert.ok(
    !value.includes(REPLACEMENT),
    "result must not contain a U+FFFD replacement character",
  );
  assert.equal(value, "€");
});

test("does not split a surrogate pair (emoji) at the boundary", () => {
  // "😀" is 4 bytes (F0 9F 98 80); a 3-byte limit lands inside it.
  const { value, truncated } = truncateUtf8("ab😀", 3);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(value, "utf8") <= 3);
  assert.ok(!value.includes(REPLACEMENT), "no replacement char");
  // No lone surrogate should survive (JSON.stringify would emit a bare \udXXX).
  assert.ok(!/[\uD800-\uDFFF]/.test(value), "no lone surrogate");
  assert.equal(value, "ab");
});

test("never exceeds maxBytes across byte limits of a multi-byte string", () => {
  const input = "héllo wörld 💥 café";
  for (let maxBytes = 0; maxBytes <= Buffer.byteLength(input, "utf8"); maxBytes++) {
    const { value } = truncateUtf8(input, maxBytes);
    assert.ok(
      Buffer.byteLength(value, "utf8") <= maxBytes,
      `maxBytes=${maxBytes}: got ${Buffer.byteLength(value, "utf8")} bytes`,
    );
    assert.ok(!value.includes(REPLACEMENT), `maxBytes=${maxBytes}: no replacement`);
    assert.ok(input.startsWith(value), `maxBytes=${maxBytes}: result must be a prefix`);
  }
});

test("leaves ASCII truncation and the under-limit path unchanged", () => {
  assert.deepEqual(truncateUtf8("hello world", 5), { value: "hello", truncated: true });
  assert.deepEqual(truncateUtf8("€", 10), { value: "€", truncated: false });
});
