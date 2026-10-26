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
