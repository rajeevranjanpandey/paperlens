import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proofreadText, estimateProofread, verbatimOverlap, PROOFREAD_MIN_OVERLAP,
} from "../shared/humanizer-core.mjs";

// Proofreading is the rewrite's opposite: fix errors, change nothing
// else. The gates - not the prompt - enforce that: protected spans and
// the number multiset must survive exactly (verifyRewrite), the length
// must stay within 0.90-1.10, at least 85% of the original wording must
// remain in order, and the drift judge must confirm identical meaning.
// Anything else comes back unchanged.

const ORIGINAL =
  "The results was consistent across all of the 20 runs in the evaluation study, and the team have reported that the the new method improves accuracy in every single trial conducted during the main experimental phase of this project.";

// Fake model following the suite's stub pattern: judges approve, and the
// "correction" is a deterministic transform of the protected work text.
function stubComplete(fix, driftVerdict = "KEEP") {
  return async (system, user) => {
    if (system.startsWith("JUDGE_DRIFT")) return driftVerdict;
    if (system.startsWith("JUDGE_PICK")) return "A";
    return fix(user.replace(/^TEXT TO PROOFREAD:\n/, ""));
  };
}

const lightFix = (work) =>
  work
    .replace("results was", "results were")
    .replace("team have", "team has")
    .replace("that the the new method", "that the new method");

test("the proofread overlap gate is exported at 0.85", () => {
  assert.equal(PROOFREAD_MIN_OVERLAP, 0.85);
});

test("a light grammar fix passes the gates and is labelled proofread", async () => {
  const res = await proofreadText(ORIGINAL, { complete: stubComplete(lightFix) });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "proofread", block.status);
  assert.ok(block.output.includes("results were"), block.output);
  assert.ok(block.output.includes("team has reported"), block.output);
  assert.ok(block.output.includes("20 runs"), block.output);
  assert.ok(!block.output.includes("the the"), block.output);
  assert.ok(verbatimOverlap(ORIGINAL, block.output) >= PROOFREAD_MIN_OVERLAP);
  assert.equal(res.stats.proofread, 1);
});

test("a heavily restructured candidate is rejected - proofreading must not reword", async () => {
  const restructure = () =>
    "Across every one of the [[P0]] evaluation runs, results held steady, with the team noting that its novel approach lifted accuracy throughout the main experimental phase.";
  const res = await proofreadText(ORIGINAL, { complete: stubComplete(restructure) });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "kept original (proofread would deviate)", block.status);
  assert.equal(block.output, block.original);
});

test("a candidate that changes a number is rejected", async () => {
  const changeNumber = (work) => lightFix(work).replace(/\[\[P\d+\]\]/, "25");
  const res = await proofreadText(ORIGINAL, { complete: stubComplete(changeNumber) });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "kept original (proofread would deviate)", block.status);
  assert.equal(block.output, block.original);
  assert.ok(block.output.includes("20 runs"), block.output);
});

test("a candidate that drops a citation is rejected", async () => {
  const cited =
    "The findings was consistent with earlier results (Smith, 2020) and they remained stable across the whole observation period of the study programme overall.";
  const dropCitation = (work) => work.replace("findings was", "findings were").replace(/\s*\[\[P\d+\]\]/, "");
  const res = await proofreadText(cited, { complete: stubComplete(dropCitation) });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "kept original (proofread would deviate)", block.status);
  assert.equal(block.output, block.original);
  assert.ok(block.output.includes("(Smith, 2020)"), block.output);
});

test("a gated candidate the drift judge rejects is not applied", async () => {
  const res = await proofreadText(ORIGINAL, { complete: stubComplete(lightFix, "DRIFT") });
  const block = res.blocks.find((b) => b.kind === "para");
  assert.equal(block.status, "kept original (drift check failed)", block.status);
  assert.equal(block.output, block.original);
});

test("structure blocks are never proofread", async () => {
  const res = await proofreadText(`Results Overview\n\n${ORIGINAL}`, { complete: stubComplete(lightFix) });
  const heading = res.blocks.find((b) => b.kind === "heading");
  assert.equal(heading.status, "kept (structure)");
  assert.equal(heading.output, heading.original);
});

test("cancelling before the run leaves every paragraph untouched", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const counting = async () => {
    calls++;
    return "";
  };
  const res = await proofreadText(`${ORIGINAL}\n\n${ORIGINAL}`, { complete: counting, signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(res.stats.cancelled, true);
  assert.ok(res.blocks.every((b) => b.status === "not run (cancelled)" && b.output === b.original));
});

test("estimateProofread counts paragraphs at ~3 calls each", () => {
  const est = estimateProofread(`A Title\n\n${ORIGINAL}\n\n${ORIGINAL}`);
  assert.equal(est.paragraphs, 2);
  assert.equal(est.approxCalls, 6);
});
