/* ------------------------------------------------------------------ */
/* Online reference verification (opt-in).                            */
/*                                                                    */
/* The local citation check can only judge format and plausibility.   */
/* This module answers the question it cannot: does the source        */
/* actually exist, and do its title, authors and year match what the  */
/* entry claims? It queries two free, key-less public APIs:           */
/*                                                                    */
/*   - Crossref  (api.crossref.org)  - DOI registry metadata          */
/*   - OpenAlex  (api.openalex.org)  - open scholarly catalog         */
/*                                                                    */
/* Only the reference entries themselves are sent - never the paper's */
/* body text. A DOI is looked up directly; an entry without a DOI is  */
/* searched by title (or by its raw line when no title was parsed).   */
/*                                                                    */
/* Verdicts are deliberately plain:                                   */
/*   verified  - a record exists and its fields match the entry       */
/*   mismatch  - a record exists but a field differs (see diffs), or  */
/*               the DOI resolves to a different paper                */
/*   not-found - no matching record in either database                */
/*   error     - the lookup itself failed (network / rate limit)      */
/* ------------------------------------------------------------------ */

const CROSSREF = "https://api.crossref.org/works";
const OPENALEX = "https://api.openalex.org/works";

/* --------------------------- text matching --------------------------- */

export function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["the", "a", "an", "of", "on", "in", "for", "and", "to", "with", "via"]);

/** Token-set similarity in [0,1]: Jaccard blended with containment so a
 *  record title that adds a subtitle still scores high. */
export function titleSimilarity(a, b) {
  const ta = new Set(normalizeTitle(a).split(" ").filter((w) => w && !STOP.has(w)));
  const tb = new Set(normalizeTitle(b).split(" ").filter((w) => w && !STOP.has(w)));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment * 0.92);
}

function normSurname(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

/* --------------------------- record shaping -------------------------- */

function crossrefRecord(m, source) {
  if (!m) return null;
  const year =
    m.published?.["date-parts"]?.[0]?.[0] ||
    m["published-online"]?.["date-parts"]?.[0]?.[0] ||
    m["published-print"]?.["date-parts"]?.[0]?.[0] ||
    m.issued?.["date-parts"]?.[0]?.[0] ||
    null;
  return {
    source,
    title: (m.title && m.title[0]) || "",
    year: year ? Number(year) : null,
    surname: m.author?.[0]?.family || "",
    doi: m.DOI || null,
    url: m.DOI ? `https://doi.org/${m.DOI}` : m.URL || null,
  };
}

function openalexRecord(w) {
  if (!w) return null;
  return {
    source: "OpenAlex",
    title: w.title || w.display_name || "",
    year: w.publication_year ? Number(w.publication_year) : null,
    surname: w.authorships?.[0]?.author?.display_name?.split(/\s+/).pop() || "",
    doi: w.doi ? w.doi.replace(/^https:\/\/doi\.org\//, "") : null,
    url: w.doi || w.id || null,
  };
}

/* ----------------------------- comparing ----------------------------- */

/**
 * Compare one parsed entry (from citation-check) against one database
 * record. `viaDoi` matters: a DOI that resolves to a different paper is
 * a mismatch, never a "not found".
 */
export function compareRecord(entry, record, viaDoi) {
  const diffs = [];
  const entryTitle = entry.titleGuess || "";
  const sim = entryTitle ? titleSimilarity(entryTitle, record.title) : null;

  if (sim != null && sim < 0.45) {
    diffs.push(
      viaDoi
        ? `The DOI resolves to a different paper: “${record.title}” (${record.source}).`
        : `Closest match has a different title: “${record.title}” (${record.source}).`,
    );
    return { status: "mismatch", sim, diffs };
  }
  if (entry.year && record.year && Math.abs(Number(entry.year) - record.year) > 1) {
    diffs.push(`Year differs: entry says ${entry.year}, the record says ${record.year}.`);
  }
  if (entry.surname && record.surname && normSurname(entry.surname) !== normSurname(record.surname)) {
    diffs.push(`First author differs: entry says ${entry.surname}, the record says ${record.surname}.`);
  }
  if (sim != null && sim < 0.8) {
    diffs.push(`Title differs somewhat from the record: “${record.title}”.`);
  }
  if (entry.doi && record.doi && entry.doi.toLowerCase() !== record.doi.toLowerCase()) {
    diffs.push(`DOI differs: the record's DOI is ${record.doi}.`);
  }
  return { status: diffs.length ? "mismatch" : "verified", sim, diffs };
}

/* ------------------------------ lookups ------------------------------ */

async function getJson(fetchFn, url, signal) {
  const res = await fetchFn(url, { headers: { Accept: "application/json" }, signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function lookupDoi(doi, fetchFn, signal) {
  try {
    const cj = await getJson(fetchFn, `${CROSSREF}/${encodeURIComponent(doi)}`, signal);
    if (cj?.message) return crossrefRecord(cj.message, "Crossref");
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    // Crossref rate limit / outage: fall through to OpenAlex.
  }
  const oj = await getJson(fetchFn, `${OPENALEX}/doi:${encodeURIComponent(doi)}`, signal);
  if (oj?.id) return openalexRecord(oj);
  return null;
}

async function searchTitle(entry, fetchFn, signal) {
  const query = entry.titleGuess || entry.line.replace(/^[•\-*]\s*/, "").slice(0, 160);
  const target = entry.titleGuess || query;
  let best = null;
  const consider = (record) => {
    if (!record || !record.title) return;
    const sim = titleSimilarity(target, record.title);
    if (!best || sim > best.sim) best = { record, sim };
  };

  try {
    const cj = await getJson(
      fetchFn,
      `${CROSSREF}?query.bibliographic=${encodeURIComponent(query)}&rows=5&select=DOI,title,author,published,issued`,
      signal,
    );
    for (const item of cj?.message?.items || []) consider(crossrefRecord(item, "Crossref"));
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    // Crossref rate limit / outage: OpenAlex below may still answer.
  }
  if (best && best.sim >= 0.8) return best.record;

  try {
    const oj = await getJson(fetchFn, `${OPENALEX}?search=${encodeURIComponent(query)}&per-page=5`, signal);
    for (const w of oj?.results || []) consider(openalexRecord(w));
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (!best) throw err;
  }
  return best && best.sim >= 0.45 ? best.record : null;
}

/* ------------------------------- main -------------------------------- */

/**
 * Verify one citation-check entry. Never throws for lookup problems -
 * they come back as status "error" so a batch run can continue.
 * `fetchFn` is injectable for tests.
 */
export async function verifyEntry(entry, fetchFn = fetch, signal) {
  const base = { index: entry.index };
  try {
    if (entry.doi) {
      const record = await lookupDoi(entry.doi, fetchFn, signal);
      if (!record) {
        return { ...base, status: "not-found", source: null, diffs: ["This DOI did not resolve in Crossref or OpenAlex."], record: null };
      }
      const cmp = compareRecord(entry, record, true);
      return { ...base, status: cmp.status, source: record.source, diffs: cmp.diffs, record };
    }
    const record = await searchTitle(entry, fetchFn, signal);
    if (!record) {
      return { ...base, status: "not-found", source: null, diffs: ["No matching record found in Crossref or OpenAlex."], record: null };
    }
    const cmp = compareRecord(entry, record, false);
    return { ...base, status: cmp.status, source: record.source, diffs: cmp.diffs, record };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return { ...base, status: "error", source: null, diffs: [`Lookup failed (${err?.message || "network error"}).`], record: null };
  }
}

/**
 * Verify a list of citation-check entries with small concurrency.
 * onProgress(done, total) fires after each entry settles.
 * Returns results in entry order.
 * @param {Array} entries
 * @param {{ fetchFn?: Function, signal?: AbortSignal, onProgress?: (done: number, total: number) => void, concurrency?: number }} [options]
 */
export async function verifyReferences(entries, { fetchFn = fetch, signal, onProgress, concurrency = 3 } = {}) {
  const results = new Array(entries.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      results[i] = await verifyEntry(entries[i], fetchFn, signal);
      done++;
      if (onProgress) onProgress(done, entries.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker));
  return results;
}
