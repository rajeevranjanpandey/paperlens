import { test } from "node:test";
import assert from "node:assert/strict";
import { citationCheck } from "../shared/citation-check.mjs";

const NOW = new Date("2026-10-25T00:00:00Z");

test("IEEE numbering gaps are flagged", () => {
  const paper = `A result [1] and another [3] are discussed here at length.

References
[1] Smith, J., "First study of systems," Journal of Examples, vol. 2, pp. 1-9, 2020.
[3] Jones, P., "Third study of systems," Journal of Examples, vol. 4, pp. 20-29, 2021.`;
  const r = citationCheck(paper, NOW);
  const jones = r.entries.find((e) => e.surname === "Jones");
  assert.ok(jones, "expected the Jones entry to be parsed");
  assert.ok(jones.flags.some((f) => f.code === "numbering-gap"), JSON.stringify(jones.flags));
});

test("author-year lists out of alphabetical order are flagged", () => {
  const paper = `Two sources (Zebra, 2020) and (Alpha, 2019) are cited in this draft.

References
Zebra, A. (2020). Later alphabetically. Journal of Examples, 3(1), 1-9.
Alpha, B. (2019). Earlier alphabetically. Journal of Examples, 2(1), 1-9.`;
  const r = citationCheck(paper, NOW);
  const alpha = r.entries.find((e) => e.surname === "Alpha");
  assert.ok(alpha.flags.some((f) => f.code === "out-of-order"), JSON.stringify(alpha.flags));
});

test("a clean, ordered list with DOIs carries no warning flags", () => {
  const paper = `One source (Alpha, 2019) supports the main claim of this draft.

References
Alpha, B. (2019). Earlier alphabetically. Journal of Examples, 2(1), 1-9. https://doi.org/10.1234/alpha.2019`;
  const r = citationCheck(paper, NOW);
  assert.equal(r.summary.entries, 1);
  assert.equal(r.summary.withDoi, 1);
  assert.equal(r.summary.flagged, 0, JSON.stringify(r.entries[0].flags));
});
