/* ------------------------------------------------------------------ */
/* Humanizer core: paragraph rewriting with protected spans,          */
/* deterministic verification and judge passes.                       */
/*                                                                    */
/* The pipeline never trusts a rewrite blindly: numbers, dates,       */
/* URLs, emails and citations are swapped for [[Pn]] placeholders      */
/* before the model sees the text and restored afterwards; every      */
/* candidate must pass mechanical checks, and any paragraph whose     */
/* candidates all fail is returned unchanged. The model itself is     */
/* injected as `complete(system, user, temperature)` so this module   */
/* stays provider-agnostic and testable (see ifm-provider.mjs).       */
/* ------------------------------------------------------------------ */

const PATTERNS = [
  /https?:\/\/\S+/g, // URLs
  /[\w.+-]+@[\w-]+\.[\w.]+/g, // emails
  /\[\d+(?:,\s*\d+)*\]/g, // citations [12], [3, 4]
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, // dates 03/06/1991
  // numbers + units. NOTE: no leading \s? - it would let this pattern start
  // on the space before a date and shadow the date alternative above.
  /[$€£]?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|ms|s|MB|GB|kHz|Hz))?/g,
];
// One combined pass: alternation order = priority, and a single scan never
// rescans replaced text, so digits inside an inserted [[Pn]] token can
// never be re-matched as a "number".
const COMBINED = new RegExp(PATTERNS.map((p) => `(?:${p.source})`).join("|"), "g");

const TOKEN_RE = /\[\[P\d+\]\]/g;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

function protect(text) {
  const protectedMap = {};
  const workText = text.replace(COMBINED, (span) => {
    const token = `[[P${Object.keys(protectedMap).length}]]`;
    protectedMap[token] = span;
    return token;
  });
  return { workText, protectedMap };
}

export function restoreText(text, protectedMap) {
  let out = text;
  for (const [token, span] of Object.entries(protectedMap)) out = out.split(token).join(span);
  return out;
}

function classify(chunk) {
  const lines = chunk.split("\n").filter((ln) => ln.trim());
  if (!lines.length) return "para";
  if (lines.every((ln) => ln.trimStart().startsWith("|"))) return "table";
  if (lines.every((ln) => /^\s*([-*•]|\d+[.)])\s+/.test(ln))) return "list";
  if (lines.length === 1 && (lines[0].startsWith("#") || (lines[0].length <= 80 && !/[.,;:]$/.test(lines[0].trim())))) return "heading";
  return "para";
}

/** Split a document into blocks; only paragraphs are rewritable. */
export function parseDocument(text) {
  const blocks = [];
  for (const raw of text.trim().split(/\n\s*\n/)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const kind = classify(chunk);
    if (kind === "para") {
      const { workText, protectedMap } = protect(chunk);
      blocks.push({ kind, original: chunk, workText, protectedMap });
    } else {
      blocks.push({ kind, original: chunk, workText: chunk, protectedMap: {} });
    }
  }
  return blocks;
}

/* ---------------------------- prompts ---------------------------- */

export const REWRITE_SYSTEM = `You rewrite text so it reads like a person wrote it, without changing its meaning.

Rules:
- Keep every fact, claim, name and number exactly. Tokens like [[P0]] are protected data: copy them byte-identical, never expand, move or drop them.
- Vary sentence length and shape naturally. Do not make every sentence the same length, and do not start consecutive sentences the same way.
- Remove stock AI transitions ("furthermore", "moreover", "in conclusion", "it is important to note") unless they carry real meaning.
- Do not add facts, examples or details that are not in the original.
- Keep the same language and roughly the same length as the original.
- Output ONLY the rewritten text, no preamble, no quotes.`;

const STERN_SUFFIX = `

Your previous attempt failed an automatic check (a protected token was changed or the length drifted).
Be careful: copy every [[P..]] token exactly, keep the length close to the original, and change nothing factual.`;

export const PICK_SYSTEM = `JUDGE_PICK. You compare two rewrites of the same paragraph.
Reply with exactly one letter: A or B - whichever keeps the original meaning
more faithfully while reading more naturally. No other text.`;

export const DRIFT_SYSTEM = `JUDGE_DRIFT. You check whether a rewrite changed any fact,
number, name or claim compared with the original. Tokens like [[P0]] are
protected data and count as unchanged. Reply with exactly one word:
KEEP if the meaning is fully preserved, DRIFT if anything factual changed.`;

/* --------------------------- verification --------------------------- */

/** Mechanical checks on a candidate rewrite (no model involved). */
export function verifyRewrite(originalWork, candidate, protectedMap) {
  const reasons = [];
  for (const token of Object.keys(protectedMap)) {
    const count = candidate.split(token).length - 1;
    if (count !== 1) reasons.push(`protected token ${token} missing or duplicated`);
  }
  // Number MULTISETS must match exactly once tokens are restored to their
  // values. A set-based check misses a repeated figure quietly dropped (or
  // doubled) by a rewrite - caught live on a real document, 2026-10-25.
  const restoreLoose = (s) => {
    let out = s;
    for (const [token, span] of Object.entries(protectedMap)) out = out.split(token).join(span);
    return out;
  };
  const counts = (s) => {
    const m = new Map();
    for (const n of restoreLoose(s).match(NUMBER_RE) || []) m.set(n, (m.get(n) || 0) + 1);
    return m;
  };
  const before = counts(originalWork);
  const after = counts(candidate);
  const diffs = [];
  for (const n of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(n) || 0) !== (after.get(n) || 0)) diffs.push(`${n}: x${before.get(n) || 0} -> x${after.get(n) || 0}`);
  }
  if (diffs.length) reasons.push(`number counts changed (${diffs.slice(0, 4).join("; ")})`);
  if (originalWork) {
    const ratio = candidate.length / Math.max(originalWork.length, 1);
    if (ratio < 0.55 || ratio > 1.7) reasons.push(`length drifted (ratio ${ratio.toFixed(2)})`);
  }
  if (!candidate.trim()) reasons.push("empty output");
  return { ok: reasons.length === 0, reasons };
}

/* --------------------------- orchestration --------------------------- */

async function judgePick(complete, original, candA, candB) {
  const user = `ORIGINAL:\n${original}\n\nCANDIDATE A:\n${candA}\n\nCANDIDATE B:\n${candB}`;
  const verdict = (await complete(PICK_SYSTEM, user, 0)).trim().toUpperCase();
  return verdict.startsWith("B") ? "B" : "A";
}

async function judgeDrift(complete, original, finalText) {
  const user = `ORIGINAL:\n${original}\n\nREWRITE:\n${finalText}`;
  const verdict = (await complete(DRIFT_SYSTEM, user, 0)).trim().toUpperCase();
  return !verdict.startsWith("DRIFT");
}

async function processBlock(block, mode, complete, styleNote = "") {
  if (block.kind !== "para") {
    return { kind: block.kind, original: block.original, output: block.original, status: "kept (structure)" };
  }
  const work = block.workText;
  const done = (candidateWork, status) => ({
    kind: block.kind, original: block.original,
    output: restoreText(candidateWork, block.protectedMap), status,
  });
  const kept = (status) => ({ kind: block.kind, original: block.original, output: block.original, status });
  // Cosmetic only: models sometimes strand punctuation around a restored
  // token ("word ,, next"). Facts are untouched - verification still runs
  // on exactly this text.
  const tidy = (s) => s.replace(/,(\s*),/g, ",").replace(/\s+([.,;:!?])/g, "$1").trim();
  const system = styleNote ? `${REWRITE_SYSTEM}\n\nAdditional style instruction: ${styleNote}` : REWRITE_SYSTEM;
  const rewrite = async (temperature, stern = false) =>
    tidy(await complete(system, `TEXT TO REWRITE:\n${work}${stern ? STERN_SUFFIX : ""}`, temperature));

  if (mode === "lite") {
    const cand = await rewrite(0.8);
    return verifyRewrite(work, cand, block.protectedMap).ok
      ? done(cand, "rewritten")
      : kept("kept original (safety check failed)");
  }

  if (mode === "ultra") {
    for (const [temp, stern] of [[0.8, false], [0.8, true], [1.0, true]]) {
      const cand = await rewrite(temp, stern);
      if (verifyRewrite(work, cand, block.protectedMap).ok) {
        return done(cand, stern ? "rewritten (after retry)" : "rewritten");
      }
    }
    return kept("kept original (all candidates failed checks)");
  }

  // premium: two candidates, judge pick, drift check, layered fallbacks
  const [candA, candB] = await Promise.all([rewrite(0.7), rewrite(1.0)]);
  const okA = verifyRewrite(work, candA, block.protectedMap).ok;
  const okB = verifyRewrite(work, candB, block.protectedMap).ok;
  if (!okA && !okB) return kept("kept original (all candidates failed checks)");
  let winner, loser;
  if (okA && okB) {
    const pick = await judgePick(complete, work, candA, candB);
    [winner, loser] = pick === "A" ? [candA, candB] : [candB, candA];
  } else {
    [winner, loser] = okA ? [candA, candB] : [candB, candA];
  }
  if (await judgeDrift(complete, work, winner)) return done(winner, "rewritten (premium)");
  if (verifyRewrite(work, loser, block.protectedMap).ok && (await judgeDrift(complete, work, loser))) {
    return done(loser, "rewritten (premium, fallback candidate)");
  }
  return kept("kept original (drift check failed)");
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Rewrite a document. `complete` is an injected model call:
 *   complete(system, user, temperature) -> Promise<string>
 * Modes: "lite" (one pass), "ultra" (pass + checks + retries),
 * "premium" (two candidates + judge pick + drift check).
 * Returns { mode, blocks: [{kind, original, output, status}], stats }.
 * @param {string} text
 * @param {{ mode?: string, complete: Function, styleNote?: string }} [options]
 */
export async function humanizeText(text, { mode = "ultra", complete, styleNote = "" } = {}) {
  if (!["lite", "ultra", "premium"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  if (typeof complete !== "function") throw new Error("humanizeText needs a complete(system, user, temperature) function");
  const blocks = parseDocument(text);
  const results = await pool(blocks, 4, (b) => processBlock(b, mode, complete, styleNote));
  const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  return {
    mode,
    blocks: results,
    stats: {
      wordsIn: words(text),
      wordsOut: words(results.map((r) => r.output).join(" ")),
      blocks: results.length,
      rewritten: results.filter((r) => r.status.startsWith("rewritten")).length,
      kept: results.filter((r) => r.status.startsWith("kept")).length,
    },
  };
}

/** Deterministic mock model call - pipeline plumbing tests only. */
export function createMockComplete() {
  const swaps = [
    [/\bFurthermore,\s*/g, "Also, "],
    [/\bMoreover,\s*/g, "On top of that, "],
    [/\bIn conclusion,\s*/g, "So, "],
    [/\bIt is important to note that\s*/g, ""],
    [/\bvery important\b/g, "key"],
    [/\ba lot of\b/g, "plenty of"],
  ];
  return async (system, user) => {
    if (system.includes("JUDGE_PICK")) return "A";
    if (system.includes("JUDGE_DRIFT")) return "KEEP";
    let text = user;
    const marker = "TEXT TO REWRITE:\n";
    if (text.includes(marker)) text = text.split(marker)[1];
    for (const [re, repl] of swaps) text = text.replace(re, repl);
    return text.trim();
  };
}
