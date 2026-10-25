import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeText, parseDocument } from "../shared/humanizer-core.mjs";
import { citationCheck } from "../shared/citation-check.mjs";

// Regression tests for the 2026-10-25 break-it pass: every attack that got
// through now has a mechanical check, plus one test for the attack the
// token check already stopped.

const echo = async (system, user) => {
  if (system.includes("JUDGE_PICK")) return "A";
  if (system.includes("JUDGE_DRIFT")) return "KEEP";
  return user.split("TEXT TO REWRITE:\n")[1].split("\n\nYour previous attempt")[0].trim();
};

test("author-year citations are protected as one span (surname swap fails)", async () => {
  const original = "Prior work confirms the effect clearly and repeatedly across many independent studies (Smith, 2020).";
  const evil = async (s, u) => (s.includes("JUDGE") ? (s.includes("PICK") ? "A" : "KEEP") : (await echo(s, u)).replace("Smith", "Smyth"));
  const r = await humanizeText(original, { complete: evil });
  assert.ok(r.blocks[0].output.includes("(Smith, 2020)"), r.blocks[0].output);
});

test("Arabic-Indic digits are protected like Latin digits", async () => {
  const original = "The sample included ٤٠ participants from the region and all of them completed the full survey instrument.";
  const evil = async (s, u) => (s.includes("JUDGE") ? (s.includes("PICK") ? "A" : "KEEP") : (await echo(s, u)).replace("٤٠", "٥٠"));
  const r = await humanizeText(original, { complete: evil });
  assert.ok(r.blocks[0].output.includes("٤٠"), r.blocks[0].output);
  assert.ok(!r.blocks[0].output.includes("٥٠"), r.blocks[0].output);
});

test("spelling a number out requires dropping its token, which is rejected", async () => {
  const original = "The benchmark covered 40 trials and every single trial completed within the strict time budget set.";
  const spellOut = async (system, user) => {
    if (system.includes("JUDGE")) return system.includes("PICK") ? "A" : "KEEP";
    const work = user.split("TEXT TO REWRITE:\n")[1].split("\n\nYour previous attempt")[0].trim();
    return work.replace(/\[\[P\d+\]\]/, "forty");
  };
  const r = await humanizeText(original, { complete: spellOut });
  assert.equal(r.blocks[0].output, original);
});

test("a tab-separated table is structure, never rewritten", async () => {
  const doc = "Method\tAccuracy\tLatency\nOurs\t95.5\t200 ms\nBase\t90.1\t340 ms";
  const blocks = parseDocument(doc);
  assert.equal(blocks[0].kind, "table");
  const r = await humanizeText(doc, { complete: echo });
  assert.equal(r.blocks[0].output, doc);
  assert.equal(r.blocks[0].status, "kept (structure)");
});

test("a wall of text is chunked into bounded blocks", async () => {
  const doc = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} of a very long unbroken wall of text that never forms a new paragraph.`).join(" ");
  const blocks = parseDocument(doc);
  assert.ok(blocks.length > 1, `expected chunking, got ${blocks.length} block(s)`);
  assert.ok(blocks.every((b) => b.original.split(/\s+/).length <= 220));
});

test("a 'Reference List' heading is recognised", () => {
  const doc = "A claim (Smith, 2020) is made here in the body of the draft text.\n\nReference List\nSmith, J. (2020). A study of things. Journal of Examples, 2(1), 1-9. https://doi.org/10.1234/abc.2020";
  const r = citationCheck(doc);
  assert.equal(r.hasReferenceSection, true);
  assert.equal(r.summary.entries, 1);
  assert.equal(r.entries[0].doi, "10.1234/abc.2020");
});

test("'(Smith et al. 2020)' without a comma still matches its entry", () => {
  const doc = "Findings were confirmed earlier (Smith et al. 2020) alongside other work (Jones, 2019) in the sample.\n\nReferences\nSmith, J. (2020). A study of things. Journal of Examples, 2(1), 1-9.\nJones, P. (2019). Other work. Journal of Examples, 1(1), 1-9.";
  const r = citationCheck(doc);
  assert.equal(r.summary.missingInText, 0, JSON.stringify(r.missing));
  assert.equal(r.summary.uncited, 0, JSON.stringify(r.entries.map((e) => e.flags)));
});
