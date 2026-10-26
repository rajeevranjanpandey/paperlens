import { test } from "node:test";
import assert from "node:assert/strict";
import {
  humanizeText, verbatimOverlap, MAX_OVERLAP,
} from "../shared/humanizer-core.mjs";

// Live benchmarking (2026-10-25) showed trim-only "rewrites" keeping
// 0.84-0.86 of the original's words in order, while genuine rewrites from
// established tools scored 0.39-0.53 with every fact intact. The pipeline
// now rejects near-verbatim candidates and retries with a sterner prompt.

test("verbatimOverlap: identical text is 1, a deep rewording is low", () => {
  const t = "The committee approved the budget after a long debate about costs and timelines for the coming year ahead.";
  assert.equal(verbatimOverlap(t, t), 1);
  const deep = "After hours of arguing over money and deadlines, the panel signed off on next year's spending plan.";
  assert.ok(verbatimOverlap(t, deep) < MAX_OVERLAP, String(verbatimOverlap(t, deep)));
  assert.equal(verbatimOverlap("", "anything"), 1);
});

const PARA =
  "Furthermore, the platform processed the incoming requests quickly and the final response time stayed below the agreed threshold across all 20 runs in the evaluation period last year, which the team considered a strong result overall for the project.";

// Stub model: all four candidates are near-verbatim trims (the old
// failure mode); the sterner retry produces a genuine rewording. Judges
// always approve.
function stubComplete() {
  let rewriteCalls = 0;
  return async (system, user) => {
    if (system.startsWith("JUDGE_DRIFT")) return "KEEP";
    if (system.startsWith("JUDGE_PICK")) return "A";
    rewriteCalls++;
    const work = user.replace(/^TEXT TO REWRITE:\n/, "").split("\n\nYour previous attempt")[0];
    if (rewriteCalls <= 4) return work.replace("Furthermore,", "Also,");
    const tok = (work.match(/\[\[P\d+\]\]/g) || [])[0] || "";
    return `Across all ${tok} evaluation runs last year, the platform handled incoming requests quickly, and response times stayed under the agreed threshold every single time - an outcome the team viewed as a strong result for the project overall.`;
  };
}

test("near-verbatim candidates are rejected; the sterner retry's deep rewrite wins", async () => {
  const res = await humanizeText(PARA, { complete: stubComplete() });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "rewritten (after retry)", block.status);
  assert.ok(block.output.includes("20"), block.output);
  assert.ok(verbatimOverlap(PARA, block.output) < MAX_OVERLAP, block.output);
});

test("short paragraphs are exempt from the depth gate", async () => {
  const short = "Furthermore, the trial succeeded in every measured respect overall.";
  const trimOnly = async (system, user) => {
    if (system.startsWith("JUDGE")) return system.startsWith("JUDGE_PICK") ? "A" : "KEEP";
    return user.replace(/^TEXT TO REWRITE:\n/, "").replace("Furthermore,", "Also,");
  };
  const res = await humanizeText(short, { complete: trimOnly });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "rewritten", block.status);
});

const DRIFT_PARA =
  "The committee published its annual report on Tuesday and the document described a year of steady growth across every regional division while also noting that several important challenges remained for the organisation in the coming period ahead.";
const DRIFT_REWRITE =
  "On Tuesday the committee released its yearly report. The document portrayed twelve months of consistent growth in all regional divisions, while also observing that a number of significant challenges still faced the organisation in the period ahead.";

function driftStub(driftVerdicts) {
  let driftCalls = 0;
  return async (system) => {
    if (system.startsWith("JUDGE_DRIFT")) {
      driftCalls++;
      return driftVerdicts[Math.min(driftCalls - 1, driftVerdicts.length - 1)];
    }
    if (system.startsWith("JUDGE_PICK")) return "A";
    return DRIFT_REWRITE;
  };
}

test("a paragraph whose candidates all drift gets one fidelity-first retry", async () => {
  // The first three drift checks fail; the fidelity-first regeneration passes.
  const res = await humanizeText(DRIFT_PARA, { complete: driftStub(["DRIFT", "DRIFT", "DRIFT", "KEEP"]) });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "rewritten (after retry)", block.status);
  assert.equal(block.output, DRIFT_REWRITE);
});

test("a paragraph that still drifts after the retry is kept unchanged", async () => {
  const res = await humanizeText(DRIFT_PARA, { complete: driftStub(["DRIFT"]) });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "kept original (drift check failed)", block.status);
  assert.equal(block.output, block.original);
});

test("descriptive prose that fails the fidelity retry falls back to a close paraphrase", async () => {
  // Drift verdicts by call order: 3 candidates + fidelity retry fail,
  // the close-paraphrase retry (5th drift check) passes.
  const res = await humanizeText(DRIFT_PARA, { complete: driftStub(["DRIFT", "DRIFT", "DRIFT", "DRIFT", "KEEP"]) });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "rewritten (after retry)", block.status);
  assert.equal(block.output, DRIFT_REWRITE);
});

test("anchor-free prose: a drift-approved near-threshold paraphrase beats keeping the original", async () => {
  // 40 distinct digit-free words (digits would be treated as figures to
  // protect); the "near" candidate swaps every 4th word (overlap ~0.75 -
  // above the 0.7 gate, below the 0.85 last-resort ceiling); the "deep"
  // candidate rewords everything but drifts.
  const tok = (i) => `q${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
  const words = Array.from({ length: 40 }, (_, i) => tok(i));
  const original = words.join(" ") + ".";
  const near = words.map((w, i) => ((i + 1) % 4 === 0 ? `syn${tok(i)}` : w)).join(" ") + ".";
  const deep = "completely different wording that shares almost nothing with the source text at all in any way whatsoever now.";
  let rewriteCalls = 0;
  let driftCalls = 0;
  const stub = async (system, user) => {
    if (system.startsWith("JUDGE_DRIFT")) {
      driftCalls++;
      return driftCalls === 1 ? "DRIFT" : "KEEP";
    }
    if (system.startsWith("JUDGE_PICK")) return "A";
    rewriteCalls++;
    return rewriteCalls === 1 ? deep : near;
  };
  const res = await humanizeText(original, { complete: stub });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "rewritten (close paraphrase)", block.status);
  assert.equal(block.output, near);
});
