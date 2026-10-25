/* ------------------------------------------------------------------ */
/* Citation check: per-reference field parsing and plausibility       */
/* flags, plus the in-text vs reference-list cross-check.             */
/*                                                                    */
/* Inspired by database-backed citation verifiers: each reference    */
/* is split into fields (authors, year, title, venue, DOI) and every  */
/* field is checked separately. PaperLens runs locally and cannot     */
/* query academic databases, so these are format and plausibility    */
/* signals - "verify this one" pointers with one-click Scholar / DOI  */
/* links - never authenticity verdicts.                               */
/*                                                                    */
/* The section/entry parsing here is deliberately tolerant: it       */
/* accepts headings like "Selected Technical References (...)",       */
/* [R1]-style labels common in grant proposals and technical          */
/* reports, corporate authors, and entries wrapped across lines.      */
/* ------------------------------------------------------------------ */

import { findCitations } from "./paper-core.mjs";

const DOI_RE = /10\.\d{4,9}\/[^\s"<>[\]]+/;
const DOI_LIKE_RE = /doi\s*[:.]|10\.\d+\//i;

/* ----------------------- section + entry parsing ----------------------- */

function findRefSection(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 110) continue;
    const m = t.match(/^(?:selected\s+)?(?:technical\s+)?(?:list\s+of\s+)?(references|bibliography|works cited)\b/i);
    if (!m) continue;
    const rest = t.slice(m[0].length).trim();
    // Remainder must be empty, a colon, or a parenthetical note - otherwise
    // this is a sentence that merely starts with the word "References".
    if (rest === "" || rest.startsWith(":") || rest.startsWith("(")) {
      return { body: lines.slice(0, i).join("\n"), section: lines.slice(i + 1).join("\n") };
    }
  }
  return null;
}

const ENTRY_START = [
  /^(?:[•\-*]\s*)?\[R?\d{1,3}\]/, // [12] or [R3]
  /^(?:[•\-*]\s*)?\d{1,3}[.)]\s/, // 3. or 3)
  /^[A-Z][\w'’-]+,\s/, // Surname, ...
  /^[A-Z][\w\s&().-]{2,60}\(\d{4}\)/, // Corporate Author (2024)
];

function splitEntries(section) {
  const entries = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^page \d+ of \d+/i.test(line)) continue; // PDF page footers
    const starts = ENTRY_START.some((re) => re.test(line));
    if (starts) {
      entries.push(line);
    } else if (entries.length === 0) {
      // Heading spillover (a wrapped heading's second line) - skip it.
      if (!(line.endsWith(")") && line.split(/\s+/).length <= 5)) entries.push(line);
    } else {
      entries[entries.length - 1] += " " + line; // wrapped continuation
    }
  }
  return entries.filter((e) => e.replace(/^[•\-*]\s*/, "").length > 8);
}

function parseRawEntry(line, index) {
  let rest = line.replace(/^[•\-*]\s*/, "");
  let num = null;
  const label = rest.match(/^\[R?(\d{1,3})\]\s*/) || rest.match(/^(\d{1,3})[.)]\s*/);
  if (label) {
    num = Number(label[1]);
    rest = rest.slice(label[0].length);
  }
  const yearM = rest.match(/\((\d{4})[a-z]?\)/) || rest.match(/\b((?:19|20)\d{2})\b/);
  let surname = "";
  const sm = rest.match(/^([A-Z][\w'’-]+),/) || rest.match(/^([A-Z][\w'’-]+)/);
  if (sm) surname = sm[1];
  return { line, index, surname, year: yearM ? yearM[1] : null, num };
}

/* --------------------------- in-text side --------------------------- */

function inTextRefs(body) {
  const pairs = [];
  const seen = new Set();
  const push = (surname, year, raw) => {
    const key = `${surname.toLowerCase()}|${year}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ surname, year, raw });
    }
  };
  for (const m of body.matchAll(/\(([^()]{2,60}?),\s*((?:19|20)\d{2})[a-z]?\)/g)) {
    const cap = m[1].split(/\s+/).find((tok) => /^[A-Z]/.test(tok));
    if (cap) push(cap.replace(/[^A-Za-z'’-]/g, ""), m[2], m[0]);
  }
  for (const m of body.matchAll(/\b([A-Z][A-Za-z'’.-]+)\s+\(((?:19|20)\d{2})[a-z]?\)/g)) {
    push(m[1], m[2], m[0]); // narrative: Smith (2020)
  }
  const nums = new Set();
  for (const m of body.matchAll(/\[(?:R)?(\d{1,3})\]/g)) nums.add(Number(m[1]));
  return { pairs, nums };
}

/* ------------------------------ fields ------------------------------ */

function parseEntry(entry, currentYear) {
  const line = entry.line;
  const flags = [];
  const add = (code, label, level = "warn") => flags.push({ code, label, level });

  let doi = null;
  const dm = line.match(DOI_RE);
  if (dm) doi = dm[0].replace(/[.,;)]+$/, "");
  if (!doi) {
    if (DOI_LIKE_RE.test(line)) {
      add("doi-invalid", "A DOI is mentioned but its syntax is not a valid DOI - check it character by character.");
    } else {
      add("no-doi", "No DOI found. Verify this entry manually (Scholar link below).", "info");
    }
  }

  const year = entry.year ? Number(entry.year) : null;
  if (!year) add("missing-year", "No publication year could be found in this entry.");
  else if (year > currentYear + 1) add("future-year", `Year ${year} is in the future - a common sign of a copied or invented reference.`);
  else if (year < 1800) add("implausible-year", `Year ${year} looks implausible for this kind of source.`, "info");

  if (!entry.surname) add("no-author", "No leading author surname could be parsed from this entry.");

  let titleGuess = null;
  const apa = line.match(/\(\d{4}[a-z]?\)\.\s*([^.]{8,})\./);
  const quoted = line.match(/["“]([^"”]{8,})["”]/);
  if (apa) titleGuess = apa[1].trim();
  else if (quoted) titleGuess = quoted[1].trim();

  const venueHint =
    /\*[^*]{3,}\*/.test(line) ||
    /\b\d+\s*\(\d+\)\s*,?\s*\d+\s*[-–]\s*\d+/.test(line) ||
    /\bpp?\.\s*\d+\s*[-–]\s*\d+/.test(line) ||
    /Journal of|Proceedings of|Press\b|Transactions on|NIST|FIPS|RFC \d+|IEEE|ACM/.test(line);
  if (!venueHint) add("no-venue", "No journal, publisher or page-range pattern was recognised in this entry.", "info");

  const scholarQuery = titleGuess || line.replace(/^[•\-*]\s*/, "").slice(0, 80);
  return {
    index: entry.index,
    line,
    surname: entry.surname || "",
    year: entry.year || null,
    num: entry.num ?? null,
    doi,
    doiUrl: doi ? `https://doi.org/${doi}` : null,
    titleGuess,
    scholarUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(scholarQuery)}`,
    flags,
  };
}

/* ------------------------------ main ------------------------------ */

/**
 * Full citation check for a draft.
 * Returns { hasReferenceSection, entries, missing, uncitedCount,
 *           ieeeMissing, styles, summary }.
 */
export function citationCheck(text, now = new Date()) {
  const styles = [...new Set(findCitations(text).map((c) => c.style))];
  const empty = {
    hasReferenceSection: false, entries: [], missing: [], uncitedCount: 0,
    ieeeMissing: [], styles,
    summary: { entries: 0, withDoi: 0, flagged: 0, missingInText: 0, uncited: 0 },
  };
  const sec = findRefSection(text);
  if (!sec) return empty;

  const currentYear = now.getFullYear();
  const entries = splitEntries(sec.section).map((line, i) => parseEntry(parseRawEntry(line, i), currentYear));
  if (!entries.length) return empty;

  // Duplicates: same surname + year + title (or same opening text).
  const seen = new Map();
  entries.forEach((e, i) => {
    const key = `${e.surname.toLowerCase()}|${e.year || ""}|${(e.titleGuess || e.line.slice(0, 40)).toLowerCase()}`;
    if (seen.has(key)) {
      const flag = { code: "duplicate-entry", label: "This entry looks like a duplicate of another entry in the list.", level: "warn" };
      e.flags.push(flag);
      entries[seen.get(key)].flags.push({ ...flag, label: "Another entry in the list looks identical to this one." });
    } else {
      seen.set(key, i);
    }
  });

  // Ordering: author-year lists are normally alphabetical; numbered lists sequential.
  const numbered = entries.filter((e) => e.num != null);
  if (numbered.length >= Math.ceil(entries.length / 2) && numbered.length >= 2) {
    entries.forEach((e, i) => {
      if (e.num != null && e.num !== i + 1) {
        e.flags.push({ code: "numbering-gap", label: `Numbered ${e.num} where ${i + 1} was expected - numbered lists normally run in citation order.`, level: "warn" });
      }
    });
  } else if (entries.length >= 2) {
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1].surname.toLowerCase();
      const cur = entries[i].surname.toLowerCase();
      if (prev && cur && cur < prev) {
        entries[i].flags.push({ code: "out-of-order", label: "Out of alphabetical order for an author-year reference list.", level: "info" });
      }
    }
  }

  // Cross-check against the in-text citations.
  const { pairs, nums } = inTextRefs(sec.body);
  const entryKeys = new Set(entries.map((e) => `${e.surname.toLowerCase()}|${e.year || ""}`));
  const missing = pairs.filter((p) => !entryKeys.has(`${p.surname.toLowerCase()}|${p.year}`));
  const entryNums = new Set(entries.map((e) => e.num).filter((n) => n != null));
  const ieeeMissing = [...nums].filter((n) => entryNums.size && !entryNums.has(n)).sort((a, b) => a - b);

  let uncitedCount = 0;
  if (pairs.length || nums.size) {
    const citedKeys = new Set(pairs.map((p) => `${p.surname.toLowerCase()}|${p.year}`));
    for (const e of entries) {
      const cited = (e.surname && e.year && citedKeys.has(`${e.surname.toLowerCase()}|${e.year}`)) || (e.num != null && nums.has(e.num));
      if (!cited) {
        uncitedCount++;
        e.flags.push({ code: "uncited-entry", label: "Listed here but never cited in the text.", level: "info" });
      }
    }
  }

  return {
    hasReferenceSection: true,
    entries,
    missing,
    uncitedCount,
    ieeeMissing,
    styles,
    summary: {
      entries: entries.length,
      withDoi: entries.filter((e) => e.doi).length,
      flagged: entries.filter((e) => e.flags.some((f) => f.level === "warn")).length,
      missingInText: missing.length,
      uncited: uncitedCount,
    },
  };
}
