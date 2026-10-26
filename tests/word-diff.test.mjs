import { test } from "node:test";
import assert from "node:assert/strict";
import { wordDiff, changedRatio } from "../shared/word-diff.mjs";

// The rewrite breakdown highlights changed wording in green. The diff
// must be conservative: punctuation-only or case-only differences are
// not changes a reader needs highlighted.

test("wordDiff: identical texts produce no changed tokens", () => {
  const t = "The committee approved the budget after a long debate.";
  const tokens = wordDiff(t, t);
  assert.equal(tokens.length, 9);
  assert.ok(tokens.every((x) => !x.changed));
  assert.equal(tokens.map((x) => x.text).join(" "), t);
  assert.equal(changedRatio(t, t), 0);
});

test("wordDiff: a fully replaced sentence is all changed", () => {
  const tokens = wordDiff(
    "Cats sleep quietly during warm afternoon hours.",
    "Engineers tested prototype under extreme conditions yesterday."
  );
  assert.equal(tokens.length, 7);
  assert.ok(tokens.every((x) => x.changed));
  assert.equal(changedRatio("Cats sleep quietly.", "Dogs bark loudly now."), 1);
});

test("wordDiff: one swapped word flags exactly that token", () => {
  const tokens = wordDiff("The cat sat on the mat", "The dog sat on the mat");
  const changed = tokens.filter((x) => x.changed);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].text, "dog");
});

test("wordDiff: an inserted word is flagged, neighbours are not", () => {
  const tokens = wordDiff(
    "Sales rose sharply last quarter.",
    "Sales rose very sharply last quarter."
  );
  assert.deepEqual(
    tokens.map((x) => [x.text, x.changed]),
    [
      ["Sales", false],
      ["rose", false],
      ["very", true],
      ["sharply", false],
      ["last", false],
      ["quarter.", false],
    ]
  );
});

test("wordDiff: punctuation-only differences count as unchanged", () => {
  const tokens = wordDiff(
    "The results were clear, and significant.",
    "The results were clear and significant"
  );
  assert.ok(tokens.every((x) => !x.changed), JSON.stringify(tokens));
});

test("wordDiff: display text is the rewritten word verbatim", () => {
  const tokens = wordDiff("Hello world.", "Hello, brave world.");
  assert.equal(tokens.map((x) => x.text).join(" "), "Hello, brave world.");
  assert.equal(tokens[0].changed, false); // "Hello," vs "Hello" — punctuation only
  assert.equal(tokens[1].changed, true); // inserted
  assert.equal(tokens[2].changed, false); // "world." survived
});

test("wordDiff: empty inputs are safe", () => {
  assert.deepEqual(wordDiff("anything", ""), []);
  assert.deepEqual(wordDiff("", ""), []);
  const tokens = wordDiff("", "Brand new text.");
  assert.ok(tokens.every((x) => x.changed));
  assert.equal(changedRatio("anything", ""), 0);
});
