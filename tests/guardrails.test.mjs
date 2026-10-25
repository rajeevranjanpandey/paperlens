import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeText, estimateRewrite, createMockComplete } from "../shared/humanizer-core.mjs";
import { createIFMComplete } from "../shared/ifm-provider.mjs";

const DOC = Array.from(
  { length: 6 },
  (_, i) => `Paragraph ${i + 1} reports a latency of 200 ms across 40 trials in the benchmark study run.`
).join("\n\n");

test("estimateRewrite counts paragraphs and approximates model calls", () => {
  const est = estimateRewrite(`A Title\n\n${DOC}`);
  assert.equal(est.paragraphs, 6);
  assert.equal(est.approxCalls, 24);
  assert.ok(est.blocks >= 7);
});

test("progress callbacks fire per block and reach the total", async () => {
  const seen = [];
  const result = await humanizeText(DOC, {
    complete: createMockComplete(),
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.equal(seen.length, result.stats.blocks);
  assert.deepEqual(seen[seen.length - 1], [result.stats.blocks, result.stats.blocks]);
  assert.equal(result.stats.cancelled, false);
});

test("cancelling before the run starts leaves every paragraph untouched", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const counting = async (...args) => {
    calls++;
    return createMockComplete()(...args);
  };
  const result = await humanizeText(DOC, { complete: counting, signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(result.stats.cancelled, true);
  assert.ok(result.blocks.every((b) => b.output === b.original && b.status === "not run (cancelled)"));
});

test("cancelling mid-run keeps finished paragraphs and skips the rest", async () => {
  const controller = new AbortController();
  const result = await humanizeText(DOC, {
    complete: createMockComplete(),
    signal: controller.signal,
    onProgress: (done) => {
      if (done === 1) controller.abort();
    },
  });
  assert.equal(result.stats.cancelled, true);
  const cancelled = result.blocks.filter((b) => b.status === "not run (cancelled)");
  assert.ok(cancelled.length >= 1, "expected some blocks to be skipped after cancel");
  assert.ok(cancelled.every((b) => b.output === b.original));
});

test("the IFM provider forwards an AbortSignal to fetch", async () => {
  let seenSignal = null;
  const fetchImpl = async (url, opts) => {
    seenSignal = opts.signal;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Done." } }] }),
      text: async () => "",
    };
  };
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl });
  const controller = new AbortController();
  await complete("S", "U", 0.5, controller.signal);
  assert.equal(seenSignal, controller.signal);
});
