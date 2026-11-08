import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeStartedAt } from "../src/events.js";

const FINISHED = 1_700_000_000_000;

test("never throws on an invalid startedAt and falls back to finishedAt", () => {
  // Invalid Date: instanceof passes, .toISOString() throws on main.
  assert.doesNotThrow(() =>
    normalizeStartedAt({ startedAt: new Date("nope"), finishedAtMs: FINISHED }),
  );
  assert.equal(
    normalizeStartedAt({ startedAt: new Date("nope"), finishedAtMs: FINISHED }),
    new Date(FINISHED).toISOString(),
  );
});

test("never throws on an unparseable string startedAt", () => {
  for (const bad of ["abc", "2024-13-99", ""]) {
    assert.doesNotThrow(() =>
      normalizeStartedAt({ startedAt: bad, finishedAtMs: FINISHED }),
    );
    assert.equal(
      normalizeStartedAt({ startedAt: bad, finishedAtMs: FINISHED }),
      new Date(FINISHED).toISOString(),
    );
  }
});

test("never throws on a non-finite durationMs", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.doesNotThrow(() =>
      normalizeStartedAt({ durationMs: bad, finishedAtMs: FINISHED }),
    );
    assert.equal(
      normalizeStartedAt({ durationMs: bad, finishedAtMs: FINISHED }),
      new Date(FINISHED).toISOString(),
    );
  }
});

test("preserves existing behaviour on valid inputs (no regression)", () => {
  const d = new Date(FINISHED - 1000);
  assert.equal(normalizeStartedAt({ startedAt: d, finishedAtMs: FINISHED }), d.toISOString());
  assert.equal(
    normalizeStartedAt({ startedAt: "2024-01-15T10:00:00.000Z", finishedAtMs: FINISHED }),
    "2024-01-15T10:00:00.000Z",
  );
  assert.equal(
    normalizeStartedAt({ startedAt: FINISHED - 5000, finishedAtMs: FINISHED }),
    new Date(FINISHED - 5000).toISOString(),
  );
  assert.equal(
    normalizeStartedAt({ durationMs: 5000, finishedAtMs: FINISHED }),
    new Date(FINISHED - 5000).toISOString(),
  );
  // number below the ms threshold is ignored, same as current code
  assert.equal(
    normalizeStartedAt({ startedAt: 1_700_000_000, finishedAtMs: FINISHED }),
    new Date(FINISHED).toISOString(),
  );
});
