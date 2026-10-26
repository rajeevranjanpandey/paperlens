import { test } from "node:test";
import assert from "node:assert/strict";
import { createIFMComplete, DEFAULT_IFM_MODEL } from "../shared/ifm-provider.mjs";

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return { calls, fetchImpl };
}

const okJson = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content, reasoning_content: "internal trace" } }] }),
  text: async () => "",
});

test("sends an OpenAI-compatible request with the bearer key and returns content only", async () => {
  const { calls, fetchImpl } = stubFetch(async () => okJson("Rewritten text."));
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl });
  const out = await complete("SYS", "USER", 0.7);
  assert.equal(out, "Rewritten text.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.ifm.ai/v1/chat/completions");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer TEST-KEY");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, DEFAULT_IFM_MODEL);
  assert.equal(body.temperature, 0.7);
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "USER" },
  ]);
});

test("strips an inlined <think> block from the content", async () => {
  const { fetchImpl } = stubFetch(async () => okJson("<think>reasoning first</think>Final answer."));
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl });
  assert.equal(await complete("S", "U"), "Final answer.");
});

test("HTTP errors surface status and a body excerpt", async () => {
  const { fetchImpl } = stubFetch(async () => ({
    ok: false, status: 401, json: async () => ({}), text: async () => "invalid api key",
  }));
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl });
  await assert.rejects(() => complete("S", "U"), /IFM API returned 401: invalid api key/);
});

test("network failures explain the reachability problem", async () => {
  const { fetchImpl } = stubFetch(async () => { throw new Error("Failed to fetch"); });
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl, retryDelays: [1, 1] });
  await assert.rejects(() => complete("S", "U"), /Could not reach the IFM API/);
});

test("a 429 is retried with backoff and the retry can succeed", async () => {
  let n = 0;
  const { calls, fetchImpl } = stubFetch(async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" };
    return okJson("Recovered.");
  });
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl, retryDelays: [1, 1, 1] });
  assert.equal(await complete("S", "U"), "Recovered.");
  assert.equal(calls.length, 2);
});

test("a persistent 429 still surfaces the rate-limit error after retries", async () => {
  const { calls, fetchImpl } = stubFetch(async () => ({
    ok: false, status: 429, json: async () => ({}), text: async () => "rate limited",
  }));
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl, retryDelays: [1, 1] });
  await assert.rejects(() => complete("S", "U"), /IFM API returned 429: rate limited/);
  assert.equal(calls.length, 3);
});

test("a missing key is rejected before any request", () => {
  assert.throws(() => createIFMComplete({ apiKey: "" }), /API key is required/);
});

test("empty completions are rejected", async () => {
  const { fetchImpl } = stubFetch(async () => okJson("   "));
  const complete = createIFMComplete({ apiKey: "TEST-KEY", fetchImpl, retryDelays: [1, 1] });
  await assert.rejects(() => complete("S", "U"), /empty completion/);
});
