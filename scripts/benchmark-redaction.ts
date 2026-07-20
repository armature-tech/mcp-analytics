import { performance } from "node:perf_hooks";
import {
  createAnalyticsRecorder,
  prepareForPreview,
} from "../src/index.js";
import { isRecord } from "../src/utils.js";

type Corpus = { name: string; iterations: number; value: unknown };

const corpora: Corpus[] = [
  {
    name: "typical-json",
    iterations: 500,
    value: {
      query: "find the latest invoices",
      filters: { status: ["open", "past_due"], limit: 25 },
      rows: Array.from({ length: 20 }, (_, index) => ({
        id: `inv_${index}`,
        amount: index * 199,
        note: "ordinary application data",
      })),
    },
  },
  {
    name: "string-heavy",
    iterations: 100,
    value: {
      documents: Array.from({ length: 200 }, (_, index) =>
        `document ${index}: ${"long ordinary prose ".repeat(80)}`
      ),
    },
  },
  {
    name: "20mb-base64",
    iterations: 5,
    value: { payload: "QUFB".repeat(5 * 1024 * 1024) },
  },
];

const OLD_BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const oldSanitizeString = (value: string) => {
  const dataUri = value.length >= 64
    && value.startsWith("data:")
    && value.includes(";base64,");
  const base64 = value.length >= 512 && OLD_BASE64_RE.test(value);
  return dataUri || base64 ? "[base64 removed]" : value;
};

const oldSanitize = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "string") return oldSanitizeString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => oldSanitize(item, seen));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        key === "data"
        && typeof entry === "string"
        && (value.type === "image" || value.type === "audio")
      ) {
        out[key] = "[binary removed]";
      } else if (key === "blob" && typeof entry === "string") {
        out[key] = "[binary removed]";
      } else {
        out[key] = oldSanitize(entry, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
};

const forceGc = () => {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
};

const measure = async (run: () => void | Promise<void>) => {
  forceGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  await run();
  return {
    elapsedMs: performance.now() - started,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
  };
};

const format = (value: number) => value.toFixed(3);
const formatChange = (before: number, after: number) =>
  `${format(((after - before) / before) * 100)}%`;
const formatCostRatio = (before: number, after: number) =>
  `${format(after / before)}x`;

console.log("benchmark=sanitizer_microbenchmark");
console.log([
  "corpus",
  "before_legacy_sanitize_ms_per_value",
  "after_bounded_secrets_ms_per_value",
  "after_vs_before_latency_change",
  "after_vs_before_cost_ratio",
  "before_heap_delta_kb",
  "after_heap_delta_kb",
].join(","));
for (const corpus of corpora) {
  // Warm both implementations before timing so JIT compilation does not
  // consistently favor whichever implementation happens to run second.
  oldSanitize(corpus.value);
  prepareForPreview(corpus.value);

  let sink: unknown;
  const before = await measure(() => {
    for (let index = 0; index < corpus.iterations; index += 1) {
      sink = oldSanitize(corpus.value);
    }
  });
  const after = await measure(() => {
    for (let index = 0; index < corpus.iterations; index += 1) {
      sink = prepareForPreview(corpus.value);
    }
  });
  void sink;

  const beforeMsPerValue = before.elapsedMs / corpus.iterations;
  const afterMsPerValue = after.elapsedMs / corpus.iterations;

  console.log([
    corpus.name,
    format(beforeMsPerValue),
    format(afterMsPerValue),
    formatChange(beforeMsPerValue, afterMsPerValue),
    formatCostRatio(beforeMsPerValue, afterMsPerValue),
    format(before.heapDeltaBytes / 1024),
    format(after.heapDeltaBytes / 1024),
  ].join(","));
}

console.log("");
console.log("benchmark=end_to_end_lifecycle");
console.log([
  "corpus",
  "after_long_lived_response_ms_per_call",
  "after_long_lived_worker_ms_per_call",
  "after_long_lived_total_ms_per_call",
  "after_serverless_await_ms_per_call",
  "after_long_lived_worker_heap_delta_kb",
  "after_serverless_await_heap_delta_kb",
].join(","));
for (const corpus of corpora) {

  const longLivedRecorder = createAnalyticsRecorder({
    armature: { emit: () => {} },
  });
  const longLivedStarted = performance.now();
  const responseStarted = performance.now();
  for (let index = 0; index < corpus.iterations; index += 1) {
    await longLivedRecorder.recordToolCall({
      name: "benchmark",
      args: corpus.value,
      result: corpus.value,
      status: "ok",
      requestId: `${corpus.name}-${index}`,
    });
  }
  const responseElapsedMs = performance.now() - responseStarted;
  const longLivedWorker = await measure(() => longLivedRecorder.flush());
  const longLivedElapsedMs = performance.now() - longLivedStarted;

  const serverlessRecorder = createAnalyticsRecorder({
    armature: { delivery: "await", emit: () => {} },
  });
  const serverless = await measure(async () => {
    for (let index = 0; index < corpus.iterations; index += 1) {
      await serverlessRecorder.recordToolCall({
        name: "benchmark",
        args: corpus.value,
        result: corpus.value,
        status: "ok",
        requestId: `${corpus.name}-serverless-${index}`,
      });
    }
  });
  await serverlessRecorder.flush();

  console.log([
    corpus.name,
    format(responseElapsedMs / corpus.iterations),
    format(longLivedWorker.elapsedMs / corpus.iterations),
    format(longLivedElapsedMs / corpus.iterations),
    format(serverless.elapsedMs / corpus.iterations),
    format(longLivedWorker.heapDeltaBytes / 1024),
    format(serverless.heapDeltaBytes / 1024),
  ].join(","));
}
