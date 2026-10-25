import { test } from "node:test";
import assert from "node:assert/strict";
import { citationCheck } from "../shared/citation-check.mjs";

const PAPER = `Some claim about systems (Smith, 2020). Another finding (Jones & Lee, 2019). A ghost citation (Ghost, 2020) has no entry.

References
Smith, J. (2020). A real study of things. Journal of Examples, 12(3), 45-61. https://doi.org/10.1234/example.2020.001
Jones, P., & Lee, K. (2019). Another study of systems. Example University Press.
Brown, T. (2099). Future work on systems. Journal of Tomorrow, 1(1), 1-9.
Brown, T. (2099). Future work on systems. Journal of Tomorrow, 1(1), 1-9.
Doe, J. (2018). Never cited work. Some Journal, 4(2), 10-19. doi:10.99/bad`;

const NOW = new Date("2026-10-25T00:00:00Z");

test("entries are parsed with fields and a summary", () => {
  const r = citationCheck(PAPER, NOW);
  assert.equal(r.hasReferenceSection, true);
  assert.equal(r.summary.entries, 5);
  assert.equal(r.summary.withDoi, 1);
  assert.ok(r.summary.flagged >= 2, JSON.stringify(r.summary));
});

test("valid DOI is extracted with a resolver link; malformed DOI is flagged", () => {
  const r = citationCheck(PAPER, NOW);
  const smith = r.entries[0];
  assert.equal(smith.doi, "10.1234/example.2020.001");
  assert.equal(smith.doiUrl, "https://doi.org/10.1234/example.2020.001");
  assert.equal(smith.titleGuess, "A real study of things");
  const doe = r.entries.find((e) => e.surname === "Doe");
  assert.ok(doe.flags.some((f) => f.code === "doi-invalid"), JSON.stringify(doe.flags));
});

test("future years, duplicates and uncited entries are flagged as signals", () => {
  const r = citationCheck(PAPER, NOW);
  const browns = r.entries.filter((e) => e.surname === "Brown");
  assert.ok(browns.every((e) => e.flags.some((f) => f.code === "future-year")));
  assert.ok(browns.some((e) => e.flags.some((f) => f.code === "duplicate-entry")));
  const doe = r.entries.find((e) => e.surname === "Doe");
  assert.ok(doe.flags.some((f) => f.code === "uncited-entry"));
});

test("in-text citation with no entry is reported missing", () => {
  const r = citationCheck(PAPER, NOW);
  assert.ok(r.missing.some((m) => m.surname === "Ghost"), JSON.stringify(r.missing));
  assert.equal(r.summary.missingInText, r.missing.length);
});

test("no reference section gives an empty, honest result", () => {
  const r = citationCheck("A short draft with a claim (Smith, 2020) and no list.", NOW);
  assert.equal(r.hasReferenceSection, false);
  assert.equal(r.entries.length, 0);
});
