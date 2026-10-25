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
 * @param {{ apiKey: string, baseUrl?: string, model?: string, fetchImpl?: Function }} opts
 * @returns {(system: string, user: string, temperature?: number, signal?: AbortSignal) => Promise<string>}
 */
export function createIFMComplete({ apiKey, baseUrl = DEFAULT_IFM_BASE_URL, model = DEFAULT_IFM_MODEL, fetchImpl } = {}) {
  if (!apiKey) throw new Error("An IFM API key is required.");
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const root = baseUrl.replace(/\/$/, "");
  return async (system, user, temperature = 0.8, signal = undefined) => {
    let resp;
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
      throw new Error(`Could not reach the IFM API (${e?.message || e}). If you are using the hosted page, the provider may be blocking browser (CORS) requests - running PaperLens locally uses the same code path.`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`IFM API returned ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message;
    const out = cleanContent(msg?.content);
    if (!out) throw new Error("The IFM API returned an empty completion.");
    return out;
  };
}
