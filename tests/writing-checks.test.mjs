import { test } from "node:test";
import assert from "node:assert/strict";
import { citationCrossCheck, toneFlags, styleIndicators } from "../shared/paper-core.mjs";

const paper = `Prior work found strong effects (Smith, 2020). Another team disagreed (Jones et al., 2019).
The classic result was later confirmed [1] and extended [2].

References

[1] Brown, A. (2018). Classic results. Journal of Nothing, 2, 5-9.
[2] White, B. (2019). Extensions. Journal of More, 3, 1-4.
[3] Never, C. (2021). Uncited entry. Journal of Silence, 1, 1-2.
Smith, J. (2020). Studies of things. Journal of Stuff, 1(1), 1-2.`;

test("citation cross-check finds missing and uncited entries", () => {
  const r = citationCrossCheck(paper);
  assert.equal(r.hasReferenceSection, true);
  const missingRaw = r.missing.map((m) => m.raw);
  assert.ok(missingRaw.some((x) => x.includes("Jones")));
  const smithCited = r.inText.some((c) => c.surname === "Smith" && c.year === "2020");
  assert.ok(smithCited);
  const uncitedLines = r.uncited.map((u) => u.line);
  assert.ok(uncitedLines.some((l) => l.includes("Never")));
  assert.ok(!uncitedLines.some((l) => l.includes("Smith")));
});

test("IEEE numbers are cross-checked", () => {
  const r = citationCrossCheck(paper);
  assert.equal(r.ieee.entryCount, 3);
  assert.deepEqual(r.ieee.missing, []); // [1] [2] both exist
  assert.deepEqual(r.ieee.uncited, [3]); // entry 3 never cited
});

test("a text without a reference section is reported as such", () => {
  const r = citationCrossCheck("I cite nobody (Smith, 2020) because there is no list.");
  assert.equal(r.hasReferenceSection, false);
  assert.deepEqual(r.missing, []);
});

test("narrative citations like Smith (2020) are recognized", () => {
  const t = `Smith (2020) found effects.

References

Smith, J. (2020). Effects. Journal, 1, 1-2.`;
  const r = citationCrossCheck(t);
  assert.equal(r.missing.length, 0);
  assert.equal(r.uncited.length, 0);
});

test("tone flags catch informal wording, second person and exclamations", () => {
  const flags = toneFlags("Basically, a lot of stuff you write is kind of vague!");
  const texts = flags.map((f) => f.text.toLowerCase());
  for (const expect of ["basically", "a lot of", "stuff", "kind of", "you", "!"]) {
    assert.ok(texts.includes(expect), `expected ${expect}`);
  }
});

test("tone flags leave formal prose alone", () => {
  const flags = toneFlags("The evidence suggests that many participants revised their claims substantially.");
  assert.equal(flags.length, 0);
});

test("style indicators report positions of recycled phrases", () => {
  const s = styleIndicators("It is important to note that findings vary. Delve into the data before claiming otherwise.");
  assert.ok(s.phraseSpans.length >= 2);
  const first = s.phraseSpans[0];
  assert.equal(first.text, "it is important to note");
  assert.equal(first.end - first.start, "it is important to note".length);
  // the span must point at the phrase inside the original text
  assert.equal(
    "It is important to note that findings vary. Delve into the data before claiming otherwise.".slice(first.start, first.end).toLowerCase(),
    "it is important to note",
  );
  assert.ok(s.phraseSpans.some((p) => p.text.includes("delve into")));
});

test("clean text has no phrase spans", () => {
  const s = styleIndicators("The survey asked participants to rank their confidence in each method.");
  assert.equal(s.phraseSpans.length, 0);
});
