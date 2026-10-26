/* ------------------------------------------------------------------ */
/* IFM (Institute of Foundation Models) provider for the humanizer.   */
/* OpenAI-compatible chat completions:                                */
/*   POST {baseUrl}/chat/completions   Authorization: Bearer <key>    */
/* The key belongs to the user, is entered in the app, and is stored  */
/* only in the browser's localStorage. Nothing is bundled or proxied. */
/* ------------------------------------------------------------------ */

export const DEFAULT_IFM_BASE_URL = "https://api.ifm.ai/v1";
export const DEFAULT_IFM_MODEL = "IFM/K2-Horizon-375B-A23B";

/** Strip a leading <think>...</think> block if a gateway inlines one. */
function cleanContent(content) {
  let out = (content || "").trim();
  if (out.startsWith("<think>")) {
    const end = out.indexOf("</think>");
    if (end !== -1) out = out.slice(end + "</think>".length).trim();
  }
  return out;
}

/**
 * Build a complete(system, user, temperature) function backed by IFM.
 * Throws an Error with a readable message on HTTP or shape problems.
 *
 * Transient failures - HTTP 429 (rate limit), 5xx, network errors and
 * empty completions - are retried with backoff (default delays 1.5s,
 * 4s, 10s, 20s) instead of failing the whole rewrite: a full paper is
 * hundreds of calls, and one rate-limit spike used to kill paragraphs
 * mid-run (found live, 2026-10-26). Client errors (4xx other than 429)
 * fail immediately. Cancelling via the AbortSignal stops retries.
 * `retryDelays` is injectable for tests.
 * @param {{ apiKey: string, baseUrl?: string, model?: string, fetchImpl?: Function, retryDelays?: number[] }} opts
 * @returns {(system: string, user: string, temperature?: number, signal?: AbortSignal) => Promise<string>}
 */
export function createIFMComplete({ apiKey, baseUrl = DEFAULT_IFM_BASE_URL, model = DEFAULT_IFM_MODEL, fetchImpl, retryDelays = [1500, 4000, 10000, 20000] } = {}) {
  if (!apiKey) throw new Error("An IFM API key is required.");
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const root = baseUrl.replace(/\/$/, "");
  const wait = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("The request was aborted."));
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("The request was aborted."));
      };
      signal?.addEventListener?.("abort", onAbort);
    });
  return async (system, user, temperature = 0.8, signal = undefined) => {
    let lastError = null;
    for (let attempt = 0; ; attempt++) {
      let resp = null;
      let netError = null;
      try {
        resp = await doFetch(`${root}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature,
          }),
        });
      } catch (e) {
        netError = e;
      }
      if (signal?.aborted) throw netError || new Error("The request was aborted.");
      if (resp && resp.ok) {
        const data = await resp.json();
        const msg = data?.choices?.[0]?.message;
        const out = cleanContent(msg?.content);
        if (out) return out;
        lastError = new Error("The IFM API returned an empty completion.");
      } else if (resp) {
        const body = await resp.text().catch(() => "");
        const err = new Error(`IFM API returned ${resp.status}: ${body.slice(0, 300)}`);
        if (resp.status !== 429 && resp.status < 500) throw err;
        lastError = err;
      } else {
        lastError = new Error(
          `Could not reach the IFM API (${netError?.message || netError}). If you are using the hosted page, the provider may be blocking browser (CORS) requests - running PaperLens locally uses the same code path.`,
        );
      }
      if (attempt >= retryDelays.length) throw lastError;
      await wait(retryDelays[attempt], signal);
    }
  };
}
