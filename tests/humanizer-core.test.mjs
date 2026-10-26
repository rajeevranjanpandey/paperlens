import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDocument, restoreText, verifyRewrite, humanizeText, createMockComplete,
} from "../shared/humanizer-core.mjs";

const SAMPLE = `Results Overview

Furthermore, the system achieved a failover time of 500 ms in 20 runs. It is important to note that the rate reached 95.5 percent on 03/06/1991 testing.

- First list item stays
- Second list item stays

In conclusion, the budget of $45,000 covered 3 sites, and results are documented in [12] for review by the team.`;

test("parser protects numbers, dates and citations", () => {
  const blocks = parseDocument(SAMPLE);
  const kinds = blocks.map((b) => b.kind);
  assert.ok(kinds.includes("heading") && kinds.includes("list"), kinds.join(","));
  const para = blocks.find((b) => b.kind === "para");
  assert.ok(!para.workText.includes("500"), para.workText);
  assert.ok(para.workText.includes("[[P"), para.workText);
  assert.ok(Object.values(para.protectedMap).includes("03/06/1991"), JSON.stringify(para.protectedMap));
  assert.equal(restoreText(para.workText, para.protectedMap), para.original);
});

test("verifyRewrite rejects dropped tokens and invented numbers", () => {
  const blocks = parseDocument("The limit is 500 ms and the share was 95.5 percent in the final run of the study.");
  const para = blocks[0];
  const good = "Also, the limit is [[P0]] and the share was [[P1]] percent in the final run of the study.";
  assert.equal(verifyRewrite(para.workText, good, para.protectedMap).ok, true);
  const dropped = "The limit is fast and the share was [[P1]] percent in the final run of the study.";
  assert.equal(verifyRewrite(para.workText, dropped, para.protectedMap).ok, false);
  const invented = "The limit is [[P0]] and the share was [[P1]] percent, up from 42 trials in the study.";
  assert.equal(verifyRewrite(para.workText, invented, para.protectedMap).ok, false);
});

test("verifyRewrite catches a repeated figure quietly dropped (multiset check)", () => {
  // Hand-built work text: two protected spans plus a bare figure used twice.
  const work = "The cap is [[P0]] with a bare 7 here and another bare 7 there in the run.";
  const map = { "[[P0]]": "500 ms" };
  const droppedRepeat = "The cap is [[P0]] with a bare 7 here in the run.";
  const verdict = verifyRewrite(work, droppedRepeat, map);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.includes("number counts changed")), verdict.reasons.join("; "));
  const doubled = "The cap is [[P0]] with a bare 7 here and another bare 7 there and a third 7 in the run.";
  assert.equal(verifyRewrite(work, doubled, map).ok, false);
  const faithful = "Also, the cap is [[P0]] with a bare 7 here and another bare 7 there in the run.";
  assert.equal(verifyRewrite(work, faithful, map).ok, true);
});

test("verifyRewrite tolerates a comma moved next to a bare year", () => {
  // Regression (found live 2026-10-26): NUMBER_RE swallows a trailing
  // comma, so a faithful rewrite that moves a comma next to a year was
  // rejected as "number counts changed (2024 -> 2024,)".
  const work = "The survey ran between 2019 and 2024 and found clear gains in the final period of the study programme.";
  const moved = "The survey ran between 2019 and 2024, and it found clear gains in the final period of the study programme.";
  assert.equal(verifyRewrite(work, moved, {}).ok, true);
  const droppedYear = "The survey ran between 2019 and found clear gains in the final period of the study programme.";
  assert.equal(verifyRewrite(work, droppedYear, {}).ok, false);
});

test("humanizeText preserves protected spans and structure", async () => {
  const result = await humanizeText(SAMPLE, { complete: createMockComplete() });
  const joined = result.blocks.map((b) => b.output).join(" ");
  for (const token of ["500", "95.5", "03/06/1991", "$45,000", "[12]"]) {
    assert.ok(joined.includes(token), `lost protected span ${token}`);
  }
  const list = result.blocks.find((b) => b.kind === "list");
  assert.equal(list.status, "kept (structure)");
  assert.ok(result.stats.rewritten >= 1, "expected at least one rewritten block");
});

test("humanizeText keeps the original when every candidate fails checks", async () => {
  const badComplete = async (system) => (system.includes("JUDGE") ? "KEEP" : "Short text with no protected tokens at all.");
  const original = "The measured latency stayed below 200 ms across all 40 trials in the benchmark run.";
  const result = await humanizeText(original, { complete: badComplete });
  assert.equal(result.blocks[0].output, original);
  assert.ok(result.blocks[0].status.startsWith("kept original"));
});

test("humanizeText falls back when the judge reports drift on both candidates", async () => {
  const drifting = async (system, user) => {
    if (system.includes("JUDGE_PICK")) return "A";
    if (system.includes("JUDGE_DRIFT")) return "DRIFT";
    return user.split("TEXT TO REWRITE:\n")[1].split("\n\nYour previous attempt")[0].trim();
  };
  const original = "The measured latency stayed below 200 ms across all 40 trials in the benchmark run.";
  const result = await humanizeText(original, { complete: drifting });
  assert.equal(result.blocks[0].output, original);
  assert.ok(result.blocks[0].status.includes("drift"), result.blocks[0].status);
});
