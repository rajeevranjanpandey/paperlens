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

// Latin + Arabic-Indic + Extended Arabic-Indic digits. JS \d is ASCII-only,
// so numbers written with Arabic digits (common in UAE documents) would
// otherwise go unprotected.
const DIG = "\\d\\u0660-\\u0669\\u06F0-\\u06F9";

const PATTERNS = [
  /https?:\/\/\S+/g, // URLs
  /[\w.+-]+@[\w-]+\.[\w.]+/g, // emails
  /\[\d+(?:,\s*\d+)*\]/g, // citations [12], [3, 4]
  // Author-year citations, parenthetical and narrative - protected as one
  // span so a rewrite cannot quietly alter a surname or year inside them.
  /\(\s*[A-Z][\w'’.-]+(?:\s+(?:et al\.|&|and)\s+[\w'’.-]+)?,?\s*\d{4}[a-z]?\s*\)/g,
  /\b[A-Z][\w'’.-]+\s+\(\d{4}[a-z]?\)/g,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, // dates 03/06/1991
  // numbers + units. NOTE: no leading \s? - it would let this pattern start
  // on the space before a date and shadow the date alternative above.
  new RegExp(`[$€£]?[${DIG}][${DIG},]*(?:\\.[${DIG}]+)?(?:\\s?(?:%|ms|s|MB|GB|kHz|Hz))?`, "g"),
];
// One combined pass: alternation order = priority, and a single scan never
// rescans replaced text, so digits inside an inserted [[Pn]] token can
// never be re-matched as a "number".
const COMBINED = new RegExp(PATTERNS.map((p) => `(?:${p.source})`).join("|"), "g");

const TOKEN_RE = /\[\[P\d+\]\]/g;
const NUMBER_RE = new RegExp(`[${DIG}][${DIG},]*(?:\\.[${DIG}]+)?`, "g");

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
  // Tab-separated rows (a table pasted from a spreadsheet) are structure too.
  if (lines.length >= 2 && lines.every((ln) => (ln.match(/\t/g) || []).length >= 2)) return "table";
  if (lines.every((ln) => /^\s*([-*•]|\d+[.)])\s+/.test(ln))) return "list";
  if (lines.length === 1 && (lines[0].startsWith("#") || (lines[0].length <= 80 && !/[.,;:]$/.test(lines[0].trim())))) return "heading";
  return "para";
}

/** Split an over-long paragraph into sentence-group chunks (<= ~180 words),
 *  so one wall of text never becomes one giant model call. */
function chunkLongPara(chunk) {
  const wordCount = chunk.split(/\s+/).length;
  if (wordCount <= 220) return [chunk];
  const sentences = chunk.match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [chunk];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).split(/\s+/).length > 180) {
      out.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [chunk];
}

/** Split a document into blocks; only paragraphs are rewritable. */
export function parseDocument(text) {
  const blocks = [];
  for (const raw of text.trim().split(/\n\s*\n/)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const kind = classify(chunk);
    if (kind === "para") {
      for (const piece of chunkLongPara(chunk)) {
        const { workText, protectedMap } = protect(piece);
        blocks.push({ kind, original: piece, workText, protectedMap });
      }
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
- Rewrite, do not edit: rebuild the sentences. Change how sentences open, split a long sentence or merge short ones, and prefer the active voice where it sounds natural. Swap verbs and sentence frames, not just connectors - fresh wording throughout. A sentence carried over word-for-word from the original is a failure, unless it consists mostly of protected tokens.
- Vary sentence length and shape naturally - mix short, punchy sentences with longer ones. Do not make every sentence the same length, and do not start consecutive sentences the same way.
- Remove stock AI transitions ("furthermore", "moreover", "in conclusion", "it is important to note") unless they carry real meaning.
- Do not add facts, examples or details that are not in the original.
- Keep the same language and roughly the same length as the original.
- Output ONLY the rewritten text, no preamble, no quotes.`;

const STERN_SUFFIX = `

Your previous attempt failed an automatic check (a protected token was changed, the length drifted, or the rewrite stayed too close to the original wording).
Be careful: copy every [[P..]] token exactly, keep the length close to the original, and change nothing factual - but reword much more deeply this time: new sentence openings, different sentence structure, same facts.`;

const DRIFT_SUFFIX = `

Your previous attempt changed the meaning of the text. Rewrite it once more, changing ONLY the wording and the sentence structure: keep every claim, quantity, comparison and qualification (words like "approximately", "average", "reported") exactly as strong as in the original. Add nothing, remove nothing, soften nothing.`;

const CLOSE_SUFFIX = `

Your previous attempts changed the meaning. Rewrite once more, staying as close to the original as possible while still changing the sentence structure: split or merge sentences, reorder clauses, and swap individual words for synonyms. Do not introduce any new image, detail or claim, and do not drop any.`;

export const PICK_SYSTEM = `JUDGE_PICK. You compare two rewrites of the same paragraph.
Reply with exactly one letter: A or B - whichever keeps the original meaning
more faithfully while reading more naturally. If both are faithful, prefer
the one whose wording and sentence structure differ more from the original.
No other text.`;

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
    for (const raw of restoreLoose(s).match(NUMBER_RE) || []) {
      // NUMBER_RE's digit/comma class swallows a trailing comma ("2024,"
      // when a rewrite moves a comma next to a bare year). That comma is
      // punctuation, not part of the figure - canonicalise before counting,
      // or faithful rewrites get rejected for moving a comma. (Found live,
      // 2026-10-26: three benchmark paragraphs returned unrewritten.)
      const n = raw.replace(/,+$/, "");
      m.set(n, (m.get(n) || 0) + 1);
    }
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

/**
 * How much of the original survives in a candidate, word for word and in
 * order: the longest-common-subsequence ratio over normalised words.
 * 1 = identical, 0 = no shared word runs. Live benchmarking (2026-10-25)
 * showed trim-only "rewrites" scoring 0.84-0.86 while genuine rewrites by
 * established tools scored 0.39-0.53 with every fact intact - so a
 * candidate at or above MAX_OVERLAP has not really been rewritten.
 * The gate applies only to paragraphs of at least 25 words: a short
 * factual line often cannot be reworded far without distorting it.
 */
export const MAX_OVERLAP = 0.7;
export const OVERLAP_MIN_WORDS = 25;

export function verbatimOverlap(original, candidate) {
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9%\s.]/g, " ").split(/\s+/).filter(Boolean);
  const a = words(original);
  const b = words(candidate);
  if (!a.length || !b.length) return 1;
  let prev = new Uint16Array(b.length + 1);
  let curr = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] / Math.max(a.length, b.length);
}

/* --------------------------- orchestration --------------------------- */

async function judgePick(complete, original, candA, candB, signal = undefined) {
  const user = `ORIGINAL:\n${original}\n\nCANDIDATE A:\n${candA}\n\nCANDIDATE B:\n${candB}`;
  const verdict = (await complete(PICK_SYSTEM, user, 0, signal)).trim().toUpperCase();
  return verdict.startsWith("B") ? "B" : "A";
}

async function judgeDrift(complete, original, finalText, signal = undefined) {
  const user = `ORIGINAL:\n${original}\n\nREWRITE:\n${finalText}`;
  const verdict = (await complete(DRIFT_SYSTEM, user, 0, signal)).trim().toUpperCase();
  return !verdict.startsWith("DRIFT");
}

async function processBlock(block, complete, styleNote = "", signal = undefined) {
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
  const rewrite = async (temperature, suffix = "") =>
    tidy(await complete(system, `TEXT TO REWRITE:\n${work}${suffix}`, temperature, signal));

  // The single pipeline, following the published methodology of
  // superhumanizer.ai / humanizethis.io: split into paragraphs, lock the
  // facts, generate candidates, verify mechanically, retry sterner, let a
  // judge arbitrates between the deepest passing candidates, then a
  // drift check walks them in order.
  // A paragraph whose candidates all fail is returned unchanged.
  // A candidate must pass the mechanical fact checks AND be a genuine
  // rewording: near-verbatim trims are rejected and retried sterner.
  const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  const acceptable = (c) => {
    if (!verifyRewrite(work, c, block.protectedMap).ok) return false;
    if (wordCount(block.original) < OVERLAP_MIN_WORDS) return true;
    return verbatimOverlap(block.original, restoreText(c, block.protectedMap)) < MAX_OVERLAP;
  };
  try {
    // Four candidates in two waves (peak concurrency stays bounded):
    // more draws = a better chance one is both deep and faithful.
    const wave1 = await Promise.all([rewrite(0.7), rewrite(0.95)]);
    if (signal?.aborted) return kept("not run (cancelled)");
    const wave2 = await Promise.all([rewrite(1.1), rewrite(1.25)]);
    const candidates = [...wave1, ...wave2];
    let verified = candidates.filter(acceptable);
    let afterRetry = false;
    if (!verified.length) {
      const retry = await rewrite(0.8, STERN_SUFFIX);
      if (acceptable(retry)) {
        verified = [retry];
        afterRetry = true;
      }
    }
    if (!verified.length) return kept("kept original (all candidates failed checks)");
    // Rank the survivors by rewrite depth (least verbatim first) - the
    // tuning goal is the deepest rewrite that stays faithful. The judge
    // arbitrates between the two deepest on naturalness, then the drift
    // check walks the order until one candidate passes.
    const depth = (c) =>
      wordCount(block.original) < OVERLAP_MIN_WORDS
        ? 0
        : verbatimOverlap(block.original, restoreText(c, block.protectedMap));
    const ranked = [...verified].sort((a, b) => depth(a) - depth(b));
    let order = ranked;
    if (ranked.length >= 2) {
      const pick = await judgePick(complete, work, ranked[0], ranked[1], signal);
      if (pick === "B") order = [ranked[1], ranked[0], ...ranked.slice(2)];
    }
    for (let i = 0; i < Math.min(order.length, 3); i++) {
      if (await judgeDrift(complete, work, order[i], signal)) {
        const status = afterRetry ? "rewritten (after retry)" : i === 0 ? "rewritten" : "rewritten (fallback candidate)";
        return done(order[i], status);
      }
    }
    // Every verified candidate drifted: escalate before giving up -
    // first a fidelity-first regeneration, then a close paraphrase
    // (structure changes only). A strict drift judge otherwise costs
    // roughly one paragraph in ten, and descriptive prose or dense
    // comparative paragraphs can fail even the fidelity retry
    // (found live, 2026-10-26).
    const retry = await rewrite(0.6, DRIFT_SUFFIX);
    if (acceptable(retry) && (await judgeDrift(complete, work, retry, signal))) {
      return done(retry, "rewritten (after retry)");
    }
    const close = await rewrite(0.4, CLOSE_SUFFIX);
    if (acceptable(close) && (await judgeDrift(complete, work, close, signal))) {
      return done(close, "rewritten (after retry)");
    }
    // Anchor-free paragraphs (no protected spans, no numbers): faith-
    // fulness there rests entirely on the drift judge, and descriptive
    // prose rewrites naturally sit near the depth threshold. A drift-
    // approved near-threshold paraphrase still beats returning the
    // original untouched (overlap 1.0), so as a last resort take the
    // deepest verified candidate under a looser 0.85 ceiling and let
    // the drift judge decide.
    if (Object.keys(block.protectedMap).length === 0) {
      const near = candidates
        .filter((c) => verifyRewrite(work, c, block.protectedMap).ok)
        .map((c) => ({ c, ov: verbatimOverlap(block.original, restoreText(c, block.protectedMap)) }))
        .filter((x) => x.ov >= MAX_OVERLAP && x.ov < 0.85)
        .sort((a, b) => a.ov - b.ov)[0];
      if (near && (await judgeDrift(complete, work, near.c, signal))) {
        return done(near.c, "rewritten (close paraphrase)");
      }
    }
    return kept("kept original (drift check failed)");
  } catch (e) {
    if (signal?.aborted) return kept("not run (cancelled)");
    throw e;
  }
}

async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0;
  let doneCount = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      doneCount++;
      onProgress?.(doneCount, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Estimate the scale of a rewrite before running it: block/paragraph
 * counts and the approximate number of model calls (~7 per paragraph:
 * four candidates, a judge pick and up to two drift checks; retries
 * add more).
 */
export function estimateRewrite(text) {
  const blocks = parseDocument(text);
  const paragraphs = blocks.filter((b) => b.kind === "para").length;
  return { blocks: blocks.length, paragraphs, approxCalls: paragraphs * 7 };
}

/**
 * Rewrite a document with the single verification-first pipeline.
 * `complete` is an injected model call:
 *   complete(system, user, temperature, signal?) -> Promise<string>
 * Options: styleNote (extra instruction), signal (AbortSignal - blocks not
 * yet started, and blocks whose model call aborts, come back as
 * "not run (cancelled)" with the original text), onProgress(done, total).
 * Returns { blocks: [{kind, original, output, status}], stats }.
 * @param {string} text
 * @param {{ complete: Function, styleNote?: string, signal?: AbortSignal, onProgress?: Function }} [options]
 */
export async function humanizeText(text, { complete, styleNote = "", signal = undefined, onProgress = undefined } = {}) {
  if (typeof complete !== "function") throw new Error("humanizeText needs a complete(system, user, temperature) function");
  const blocks = parseDocument(text);
  const results = await pool(
    blocks,
    4,
    (b) => {
      if (signal?.aborted && b.kind === "para") {
        return { kind: b.kind, original: b.original, output: b.original, status: "not run (cancelled)" };
      }
      return processBlock(b, complete, styleNote, signal);
    },
    onProgress
  );
  const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  return {
    blocks: results,
    stats: {
      wordsIn: words(text),
      wordsOut: words(results.map((r) => r.output).join(" ")),
      blocks: results.length,
      rewritten: results.filter((r) => r.status.startsWith("rewritten")).length,
      kept: results.filter((r) => r.status.startsWith("kept")).length,
      cancelled: results.some((r) => r.status === "not run (cancelled)"),
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
