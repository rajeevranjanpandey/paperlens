import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeText } from "../shared/humanizer-core.mjs";

test("stranded punctuation from a rewrite is tidied before delivery", async () => {
  const original = "During 2025, the platform held steady across the whole evaluation period.";
  // A model that wedges the protected year token between commas and
  // leaves a space before the full stop - plausible with real models.
  const sloppy = async (system, user) => {
    if (system.includes("JUDGE")) return "KEEP";
    const work = user.split("TEXT TO REWRITE:\n")[1];
    return work.replace(", the platform", ",, the platform").replace("period.", "period .");
  };
  const result = await humanizeText(original, { mode: "ultra", complete: sloppy });
  assert.equal(result.blocks[0].status, "rewritten");
  assert.equal(result.blocks[0].output, original);
  assert.ok(!result.blocks[0].output.includes(",,"));
});
