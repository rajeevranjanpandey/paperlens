import { test } from "node:test";
import assert from "node:assert/strict";

import { citationCheck } from "../shared/citation-check.mjs";
import { verifyEntry, verifyReferences, titleSimilarity, compareRecord } from "../shared/reference-verify.mjs";

/* A tiny paper with four references:
 * [1] real DOI + matching fields          -> verified
 * [2] DOI that does not resolve           -> not-found
 * [3] DOI that resolves to another paper  -> mismatch (different paper)
 * [4] no DOI, title search, wrong year    -> mismatch (year diff)
 */
const PAPER = `Some body text citing nothing in particular.

References
[1] Vaswani, A. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30. https://doi.org/10.5555/3295222.3295349
[2] Smith, J. (2020). A study of invented things. Journal of Nowhere, 4(2), 10-19. https://doi.org/10.9999/fake.doi.123
[3] Doe, J. (2021). Quantum bananas in orbit. https://doi.org/10.5555/3295222.3295349
[4] Brown, L. (2019). Deep learning for tide prediction. Ocean Modelling, 140, 101-112.
`;

function jsonRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const ATTENTION = {
  message: {
    DOI: "10.5555/3295222.3295349",
    title: ["Attention is all you need"],
    author: [{ family: "Vaswani", given: "Ashish" }],
    published: { "date-parts": [[2017]] },
  },
};

function fakeFetch(url) {
  const u = String(url);
  if (u.includes("api.crossref.org/works/10.5555")) return Promise.resolve(jsonRes(ATTENTION));
  if (u.includes("api.crossref.org/works/10.9999")) return Promise.resolve(jsonRes({}, 404));
  if (u.includes("api.openalex.org/works/doi:10.9999")) return Promise.resolve(jsonRes({}, 404));
  if (u.includes("api.crossref.org/works?")) {
    // Title search for entry [4]: same paper, but the record says 2015.
    return Promise.resolve(
      jsonRes({
        message: {
          items: [
            {
              DOI: "10.1016/j.ocemod.2015.06.001",
              title: ["Deep learning for tide prediction"],
              author: [{ family: "Brown", given: "Laura" }],
              published: { "date-parts": [[2015]] },
            },
          ],
        },
      }),
    );
  }
  return Promise.reject(new Error(`unexpected URL ${u}`));
}

test("titleSimilarity: identical and near titles score high, unrelated low", () => {
  assert.ok(titleSimilarity("Attention is all you need", "Attention Is All You Need") > 0.95);
  assert.ok(titleSimilarity("Deep learning for tide prediction", "Deep learning for tide prediction: a survey") > 0.7);
  assert.ok(titleSimilarity("Quantum bananas in orbit", "Attention is all you need") < 0.3);
});

test("compareRecord: year tolerance is ±1, surname mismatch is flagged", () => {
  const entry = { titleGuess: "Some paper title here", year: "2020", surname: "Smith", doi: null };
  const rec = { source: "Crossref", title: "Some paper title here", year: 2021, surname: "Smith", doi: null, url: null };
  assert.equal(compareRecord(entry, rec, false).status, "verified");
  assert.equal(compareRecord(entry, { ...rec, year: 2015 }, false).status, "mismatch");
  assert.equal(compareRecord(entry, { ...rec, surname: "Jones" }, false).status, "mismatch");
});

test("verifyEntry: DOI with matching record verifies", async () => {
  const { entries } = citationCheck(PAPER);
  const r = await verifyEntry(entries[0], fakeFetch);
  assert.equal(r.status, "verified");
  assert.equal(r.source, "Crossref");
});

test("verifyEntry: unresolvable DOI is not-found", async () => {
  const { entries } = citationCheck(PAPER);
  const r = await verifyEntry(entries[1], fakeFetch);
  assert.equal(r.status, "not-found");
});

test("verifyEntry: DOI resolving to a different paper is a mismatch, not verified", async () => {
  const { entries } = citationCheck(PAPER);
  const r = await verifyEntry(entries[2], fakeFetch);
  assert.equal(r.status, "mismatch");
  assert.ok(r.diffs.some((d) => d.includes("different paper")));
});

test("verifyEntry: no DOI falls back to title search and flags a wrong year", async () => {
  const { entries } = citationCheck(PAPER);
  const r = await verifyEntry(entries[3], fakeFetch);
  assert.equal(r.status, "mismatch");
  assert.ok(r.diffs.some((d) => d.includes("Year differs")));
});

test("verifyEntry: network failure becomes an error result, never a throw", async () => {
  const { entries } = citationCheck(PAPER);
  const r = await verifyEntry(entries[0], () => Promise.reject(new Error("offline")));
  assert.equal(r.status, "error");
});

test("verifyEntry: a Crossref 429 on title search falls back to OpenAlex", async () => {
  const entry = { index: 0, line: "Brown, L. (2019). Deep learning for tide prediction.", surname: "Brown", year: "2019", doi: null, titleGuess: "Deep learning for tide prediction" };
  const fetchFn = (url) => {
    const u = String(url);
    if (u.includes("api.crossref.org/works?")) return Promise.resolve(jsonRes({}, 429));
    if (u.includes("api.openalex.org/works?")) {
      return Promise.resolve(
        jsonRes({
          results: [
            {
              title: "Deep learning for tide prediction",
              publication_year: 2019,
              doi: "https://doi.org/10.1016/j.ocemod.2019.06.001",
              authorships: [{ author: { display_name: "Laura Brown" } }],
            },
          ],
        }),
      );
    }
    return Promise.reject(new Error(`unexpected URL ${u}`));
  };
  const r = await verifyEntry(entry, fetchFn);
  assert.equal(r.status, "verified");
  assert.equal(r.source, "OpenAlex");
});

test("verifyReferences: whole list, order preserved, progress reported", async () => {
  const { entries } = citationCheck(PAPER);
  const seen = [];
  const results = await verifyReferences(entries, {
    fetchFn: fakeFetch,
    onProgress: (d) => seen.push(d),
  });
  assert.deepEqual(
    results.map((r) => r.status),
    ["verified", "not-found", "mismatch", "mismatch"],
  );
  assert.equal(seen[seen.length - 1], entries.length);
});
