import { test } from "node:test";
import assert from "node:assert/strict";
import { citationCheck } from "../shared/citation-check.mjs";

// Mirrors the reference style of a real grant proposal (WASLA, Revised.pdf):
// a "Selected Technical References" heading with a parenthetical note,
// [R#] labels, DOIs, a corporate author, and entries wrapped across lines.
const DOC = `The architecture follows zero trust principles [R1] and multipath transport [R3] throughout the design.

Selected Technical References (source verification; outside portal word-limit fields)
• [R1] Rose, S., Borchert, O., Mitchell, S., and Connelly, S. (2020). Zero Trust Architecture. NIST
SP 800-207. https://doi.org/10.6028/NIST.SP.800-207
• [R2] Ferlin, S., Alay, Ö., Mehani, O., and Boreli, R. (2016). BLEST: Blocking Estimation-based
MPTCP Scheduler for Heterogeneous Networks. IFIP Networking. https://doi.org/10.1109/IFIPNetworking.2016.7497206
• [R5] WireGuard. Protocol & Cryptography. https://www.wireguard.com/protocol/
• [R7] National Institute of Standards and Technology (2024). Module-Lattice-Based Key-Encapsulation
Mechanism Standard. FIPS 203. https://doi.org/10.6028/NIST.FIPS.203`;

const NOW = new Date("2026-10-25T00:00:00Z");

test("a 'Selected Technical References' heading is recognised", () => {
  const r = citationCheck(DOC, NOW);
  assert.equal(r.hasReferenceSection, true);
  assert.equal(r.summary.entries, 4, JSON.stringify(r.entries.map((e) => e.line)));
});

test("wrapped entries are joined and their DOIs extracted", () => {
  const r = citationCheck(DOC, NOW);
  const r1 = r.entries.find((e) => e.num === 1);
  assert.ok(r1.line.includes("SP 800-207"), r1.line);
  assert.equal(r1.doi, "10.6028/NIST.SP.800-207");
  assert.equal(r.summary.withDoi, 3);
});

test("numbered citations in the text with no entry are reported", () => {
  const r = citationCheck(DOC, NOW);
  assert.deepEqual(r.ieeeMissing, [3]);
});

test("an entry with no year is flagged; a corporate author still parses", () => {
  const r = citationCheck(DOC, NOW);
  const r5 = r.entries.find((e) => e.num === 5);
  assert.ok(r5.flags.some((f) => f.code === "missing-year"), JSON.stringify(r5.flags));
  const r7 = r.entries.find((e) => e.num === 7);
  assert.equal(r7.year, "2024");
  assert.equal(r7.doi, "10.6028/NIST.FIPS.203");
});
