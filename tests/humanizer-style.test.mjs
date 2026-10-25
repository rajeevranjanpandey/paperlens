import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeText } from "../shared/humanizer-core.mjs";

test("a style note reaches the rewrite prompt but not the judge prompts", async () => {
  const systems = [];
  const spy = async (system, user) => {
    systems.push(system);
    if (system.includes("JUDGE_PICK")) return "A";
    if (system.includes("JUDGE_DRIFT")) return "KEEP";
    return user.split("TEXT TO REWRITE:\n")[1].trim();
  };
  const original = "The measured latency stayed below 200 ms across all 40 trials in the benchmark run.";
  const result = await humanizeText(original, { mode: "premium", complete: spy, styleNote: "Use a relaxed, casual tone." });
  assert.equal(result.blocks[0].status.startsWith("rewritten"), true);
  const rewriteSystems = systems.filter((s) => s.includes("You rewrite text"));
  assert.ok(rewriteSystems.length >= 2, "premium should issue two rewrite calls");
  assert.ok(rewriteSystems.every((s) => s.includes("Additional style instruction: Use a relaxed, casual tone.")));
  const judgeSystems = systems.filter((s) => s.includes("JUDGE"));
  assert.ok(judgeSystems.every((s) => !s.includes("casual tone")), "judges must not receive the style note");
});
