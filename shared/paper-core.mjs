// PaperLens analysis engine.
// Everything runs locally in the browser. No text is uploaded anywhere.
// Three checks: similarity against known references, writing-style indicators,
// and paper quality metrics. Results are descriptive, not verdicts.

/* ------------------------------------------------------------------ */
/* Reference corpus: short original sample texts written for this app.  */
/* They stand in for a reference library and are clearly labeled.        */
/* ------------------------------------------------------------------ */

export const SAMPLE_REFERENCES = [
  {
    id: "ref-climate",
    title: "Sample essay: Climate adaptation in coastal cities",
    text: `Coastal cities face a double burden as the climate warms. Sea levels rise slowly enough to ignore in daily life, yet fast enough to overwhelm drainage systems built for a calmer century. Adaptation therefore tends to arrive as a reaction to disaster rather than as a planned investment. After Hurricane Sandy, New York funded sea walls and elevated mechanical rooms only after the water had already claimed the subway tunnels.

The economics of adaptation remain contested. Hard infrastructure, such as barriers and levees, protects property values and buys visible reassurance, but it locks a city into defending a fixed shoreline. Soft measures, including restored wetlands, permeable pavements and managed retreat, spread risk rather than concentrating it, yet they are harder to photograph at a ribbon cutting. Planners who combine both approaches usually begin with the wetlands and reserve the concrete for places where nothing cheaper will suffice.

A fair conclusion is that adaptation succeeds when it is treated as an ongoing negotiation with water rather than a single engineering victory. Cities that measure, publish and revise their flood maps tend to spend less and lose less, because each revision transfers a little of the cost of certainty away from the future.`,
  },
  {
    id: "ref-ml",
    title: "Sample essay: The limits of scale in machine learning",
    text: `The recent history of machine learning is a history of scale. More data, more parameters and more compute have produced systems that translate, summarize and reason beyond what earlier architectures achieved. Yet scale has not dissolved the older problems; it has mostly made them more expensive to notice. A model trained on biased data grows more fluent in that bias, not less.

Interpretability research tries to open the box after the fact, and it has produced genuinely useful tools, from attention maps to probes that recover features. What these tools cannot yet do is certify that a system will fail safely in conditions it has never seen. The gap between testing and deployment is therefore where most real-world harm enters, quietly, through distribution shift and through users who reasonably assume that fluency implies correctness.

A sober reading is that scale bought performance and postponed understanding. The next decade of the field may belong less to bigger models than to better accounts of when a model should be trusted, which is an engineering question and an institutional one.`,
  },
  {
    id: "ref-social",
    title: "Sample essay: Attention as an economic resource",
    text: `The scarce input of the modern internet is not content but attention. Every feed, notification and autoplaying video competes for the same few hours a person is willing to give. Platforms that win this competition do so by learning, at fine granularity, what keeps an individual scrolling, and the resulting systems are extraordinarily good at their job.

The trouble with a market this efficient is that attention is not just another consumable. It is the raw material of deliberation, study and relationships. A service that fragments it into ever shorter intervals is not obviously serving the person whose attention it has rented. The debate about design ethics is often framed as a question of willpower, which misplaces the burden, because the environment is engineered by teams with far better instruments than any individual user.

Regulation has begun to treat attention as a resource worth protecting, most visibly through rules aimed at minors. Whether such rules generalize may depend on whether societies come to treat concentrated, uninterrupted attention the way they treat clean water: valuable precisely because it is easy to pollute and slow to restore.`,
  },
  {
    id: "ref-work",
    title: "Sample essay: Remote work and the geography of talent",
    text: `Remote work did not invent distributed teams, but it made them ordinary. What was once a necessity for companies with offices in several countries became, within a few years, a default arrangement for jobs that produce files rather than objects. The consequences are still being tallied.

The first and most cited effect is geographic. A worker in a smaller city no longer needs to accept a local wage ceiling, and employers gain access to talent pools they previously reached only through relocation packages. The second effect is subtler: collaboration itself has been redesigned. Documents, comments and recorded meetings now carry much of the load that hallways once carried, which favors people who write well and disadvantages those whose strengths were conversational.

The honest summary is that remote work traded proximity for flexibility, and that the trade is not free. Some organizations have quietly discovered that mentoring and disagreement both suffer at a distance, and a number of them have settled on hybrid arrangements not because they are trendy, but because they are the least bad compromise anyone has found.`,
  },
  {
    id: "ref-education",
    title: "Sample essay: Grading as a design problem",
    text: `A grade is a compression algorithm. It takes a semester of work, with all its false starts and recoveries, and reduces it to a single symbol that will be read by people who never saw the work itself. Any compression loses information, and the interesting question is not whether grades are imperfect but which information they systematically discard.

Decades of measurement research suggest that grades discard process. Two students with identical final scores may have arrived by entirely different routes, one through steady revision and one through a single desperate night. When the grade is the only artifact that survives, both students learn the same lesson: only the destination is recorded.

Alternatives exist, and most of them preserve more of the signal at the cost of more labor: portfolios, specifications grading, and narrative feedback all trade the convenience of a single number for a richer description. The obstacle to adopting them is rarely evidence. It is that the compressed symbol is convenient for exactly the people, institutions and algorithms that consume it. Designing assessment is therefore not a pedagogical question alone; it is a negotiation with everyone downstream who prefers a number.`,
  },
  {
    id: "ref-security",
    title: "Sample essay: Passwords, people and systems",
    text: `The password is an unhappy technology. It asks each user to generate, memorize and rotate high-entropy secrets, which is a task humans perform badly, and then it blames them for the failure. Every large breach that ends in credential stuffing is, in part, a story about a system that outsourced its security to the least supported component.

Multi-factor authentication improves the situation by adding something a user has to something a user knows. Phishing-resistant variants, built on public key cryptography, go further by binding the authentication to the legitimate service. Adoption, however, follows a familiar pattern in security engineering: the strongest controls are the least convenient, and convenience usually wins the argument at the help desk.

The durable fix is probably structural rather than heroic. Systems that assume users will choose weak secrets, reuse them and fall for convincing fakes, and that still fail safely when all three happen, are more trustworthy than systems that demand perfection. Security that depends on people behaving like protocols will keep producing the same breach report with different dates.`,
  },
];

/* ------------------------------------------------------------------ */
/* Tokenization                                                        */
/* ------------------------------------------------------------------ */

const WORD_RE = /[A-Za-z\u00C0-\u024F0-9]+(?:['’-][A-Za-z]+)*/g;

/** Words with their character offsets, lowercased for comparison. */
export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(WORD_RE)) {
    out.push({ raw: m[0], norm: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Split into sentences with character ranges. Handles common abbreviations roughly. */
export function splitSentences(text) {
  const sentences = [];
  const textNoCode = text.replace(/```[\s\S]*?```/g, " ");
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  for (const m of textNoCode.matchAll(re)) {
    const s = m[0].trim();
    if (!s) continue;
    // skip pure headings / list markers / urls / numbers
    if (/^(#{1,6}\s|[-*•]\s|\d+[.)]\s)/.test(s) && s.split(/\s+/).length < 12) continue;
    if (/^https?:\/\//.test(s)) continue;
    sentences.push({ text: s, start: m.index + (m[0].length - m[0].trimStart().length), end: m.index + m[0].trimEnd().length });
  }
  return sentences;
}

/** Paragraphs (blank-line separated) with ranges. */
export function splitParagraphs(text) {
  const paras = [];
  const re = /[\s\S]+?(?:\n\s*\n|$)/g;
  for (const m of text.matchAll(re)) {
    const t = m[0].trim();
    if (t) paras.push({ text: t, start: m.index, end: m.index + m[0].length });
  }
  return paras;
}

/* ------------------------------------------------------------------ */
/* Similarity: n-gram shingles against reference documents              */
/* ------------------------------------------------------------------ */

const SHINGLE_N = 7; // ~7 consecutive words = a matching phrase

function shingleMap(tokens, n) {
  const map = new Map(); // key -> [tokenIndex]
  for (let i = 0; i + n <= tokens.length; i++) {
    const key = tokens.slice(i, i + n).map((t) => t.norm).join(" ");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  }
  return map;
}

/** Contiguous runs of matched token indices, each tagged with its source. */
function runsForMatched(tokens, index, n) {
  // tokenIndex -> Set(refId). A matching shingle marks its whole n-word span,
  // not just its first word, so runs never stop six words early.
  const hit = new Map();
  const mark = (idx, refId) => {
    if (!hit.has(idx)) hit.set(idx, new Set());
    hit.get(idx).add(refId);
  };
  for (let i = 0; i + n <= tokens.length; i++) {
    const key = tokens.slice(i, i + n).map((t) => t.norm).join(" ");
    const refs = index.get(key);
    if (!refs) continue;
    for (const refId of refs) {
      for (let k = i; k < i + n; k++) mark(k, refId);
    }
  }
  const runs = [];
  let i = 0;
  while (i < tokens.length) {
    if (!hit.has(i)) {
      i++;
      continue;
    }
    let j = i;
    const refCount = new Map();
    while (j < tokens.length && hit.has(j)) {
      for (const r of hit.get(j)) refCount.set(r, (refCount.get(r) || 0) + 1);
      j++;
    }
    const best = [...refCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    runs.push({ startToken: i, endToken: j - 1, refId: best, length: j - i });
    i = j;
  }
  return runs;
}

/**
 * Compare a paper against reference documents.
 * Reports matched text within the given references only. This is not an
 * internet-wide or database-backed plagiarism check.
 */
export function similarityReport(text, references) {
  const tokens = tokenize(text);
  const refs = references.length ? references : SAMPLE_REFERENCES;
  const index = new Map(); // shingleKey -> Set(refId)
  const refTokens = new Map();
  for (const r of refs) {
    const rt = tokenize(r.text);
    refTokens.set(r.id, rt.length);
    for (const key of shingleMap(rt, SHINGLE_N).keys()) {
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(r.id);
    }
  }
  const runs = runsForMatched(tokens, index, SHINGLE_N)
    .filter((r) => r.length >= SHINGLE_N) // drop single-shingle noise
    .map((r) => ({
      refId: r.refId,
      start: tokens[r.startToken].start,
      end: tokens[r.endToken].end,
      wordCount: r.endToken - r.startToken + 1,
      excerpt: text.slice(tokens[r.startToken].start, tokens[r.endToken].end),
    }));

  const matchedWords = runs.reduce((s, r) => s + r.wordCount, 0);
  const totalWords = tokens.length;
  const perSource = new Map();
  for (const r of runs) {
    const cur = perSource.get(r.refId) || { words: 0, runs: 0 };
    cur.words += r.wordCount;
    cur.runs++;
    perSource.set(r.refId, cur);
  }
  const refTitle = new Map(refs.map((r) => [r.id, r.title]));

  // Self-repetition: repeated 12-word spans inside the paper itself.
  const seen = new Map();
  const selfRuns = [];
  for (let i = 0; i + 12 <= tokens.length; i++) {
    const key = tokens.slice(i, i + 12).map((t) => t.norm).join(" ");
    const first = seen.get(key);
    if (first != null && first < i) {
      selfRuns.push({ start: tokens[i].start, end: tokens[i + 11].end });
    } else if (first == null) {
      seen.set(key, i);
    }
  }

  return {
    matchedWords,
    totalWords,
    percent: totalWords ? (matchedWords / totalWords) * 100 : 0,
    runs,
    perSource: [...perSource.entries()].map(([id, v]) => ({
      refId: id,
      title: refTitle.get(id) || id,
      ...v,
      percentOfPaper: totalWords ? (v.words / totalWords) * 100 : 0,
    })),
    selfRepetition: {
      runs: selfRuns,
      percent: totalWords ? (selfRuns.reduce((s, r) => s + 12, 0) / totalWords) * 100 : 0,
    },
    referenceCount: refs.length,
  };
}

/* ------------------------------------------------------------------ */
/* Writing-style indicators (experimental; no verdict)                  */
/* ------------------------------------------------------------------ */

const AI_PHRASES = [
  "in today's fast-paced world",
  "in the modern world",
  "it is important to note",
  "it is worth noting",
  "delve into",
  "delves into",
  "a rich tapestry",
  "navigating the complexities",
  "in the realm of",
  "plays a crucial role",
  "in conclusion",
  "furthermore",
  "moreover",
  "additionally",
  "overall",
  "it is clear that",
  "underscores the importance",
  "cannot be overstated",
  "as an ai",
  "as technology continues to advance",
];

const DISCOURSE_STARTERS = ["furthermore", "moreover", "additionally", "however", "therefore", "overall", "in addition", "consequently"];

/** Sentence-length coefficient of variation. Low values look uniform. */
function sentenceLengthCV(sentences) {
  const lens = sentences.map((s) => tokenize(s.text).length).filter((n) => n > 3);
  if (lens.length < 5) return null;
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const varr = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  return { mean, sd: Math.sqrt(varr), cv: Math.sqrt(varr) / (mean || 1) };
}

/**
 * Experimental writing-style indicators. These describe statistical
 * features of the text. They cannot prove who or what wrote it, and no
 * probability of AI authorship is computed.
 */
export function styleIndicators(text) {
  const lower = text.toLowerCase();
  const sentences = splitSentences(text);
  const tokens = tokenize(text);
  const types = new Set(tokens.map((t) => t.norm)).size;
  const cv = sentenceLengthCV(sentences);

  const phraseHits = AI_PHRASES.filter((p) => lower.includes(p));
  const starters = {};
  let starterTotal = 0;
  for (const s of sentences) {
    const first = tokenize(s.text)[0]?.norm;
    if (first && DISCOURSE_STARTERS.includes(first)) {
      starters[first] = (starters[first] || 0) + 1;
      starterTotal++;
    }
  }
  const contractions = (text.match(/\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi) || []).length;
  const emDashes = (text.match(/—/g) || []).length;
  const semicolons = (text.match(/;/g) || []).length;
  const exclamations = (text.match(/!/g) || []).length;

  return {
    wordCount: tokens.length,
    sentenceCount: sentences.length,
    sentenceLength: cv,
    typeTokenRatio: tokens.length ? types / tokens.length : null,
    commonPhrases: phraseHits,
    starterRepetition: { counts: starters, total: starterTotal, sentenceShare: sentences.length ? starterTotal / sentences.length : 0 },
    contractions,
    punctuationVariety: { emDashes, semicolons, exclamations },
  };
}

/* ------------------------------------------------------------------ */
/* Quality: readability, citations, structure                           */
/* ------------------------------------------------------------------ */

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const groups = w.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function readability(text) {
  const sentences = splitSentences(text);
  const tokens = tokenize(text);
  const wordCount = tokens.length;
  const sentenceCount = Math.max(1, sentences.length);
  const syl = tokens.reduce((s, t) => s + syllables(t.raw), 0);
  if (wordCount < 50) return { words: wordCount, sentences: sentenceCount, enough: false };
  const flesch = 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syl / wordCount);
  const grade = 0.39 * (wordCount / sentenceCount) + 11.8 * (syl / wordCount) - 15.59;
  return {
    words: wordCount,
    sentences: sentenceCount,
    enough: true,
    fleschReadingEase: Math.round(flesch * 10) / 10,
    fleschKincaidGrade: Math.round(grade * 10) / 10,
  };
}

const CITATION_PATTERNS = [
  { style: "APA", re: /\((?:[A-Z][a-z]+,\s\d{4}[a-z]?(?:,\s?p\.\s?\d+)?)\)/g },
  { style: "APA", re: /\([A-Z][a-z]+(?:\s(?:et al\.|&\s[A-Z][a-z]+))?,\s\d{4}\)/g },
  { style: "MLA", re: /\([A-Z][a-z]+\s?\d{3,4}\)/g },
  { style: "IEEE", re: /\[\d{1,3}\]/g },
  { style: "Harvard", re: /\([A-Z][a-z]+\s\d{4}[a-z]?\s?\)/g },
];

/** In-text citation matches with styles and positions. */
export function findCitations(text) {
  const out = [];
  for (const { style, re } of CITATION_PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({ style, text: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  // IEEE [n] only counts when several distinct numbers appear (else it's probably a list marker)
  const ieee = out.filter((c) => c.style === "IEEE");
  if (new Set(ieee.map((c) => c.text)).size < 3) {
    return out.filter((c) => c.style !== "IEEE");
  }
  // dedupe overlapping matches by start
  const seen = new Map();
  for (const c of out) if (!seen.has(c.start)) seen.set(c.start, c);
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

const PASSIVE_RE = /\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(\w+(?:ed|en|wn|nt))\b/gi;
const IRREGULAR_PASSIVES = new Set(["known", "shown", "written", "given", "taken", "seen", "done", "held", "made", "found", "considered", "based", "used", "called", "defined"]);

/** Passive-voice occurrences (approximate; may miss irregulars). */
export function passiveVoice(text) {
  const hits = [];
  for (const m of text.matchAll(PASSIVE_RE)) {
    const word = m[1].toLowerCase();
    if (IRREGULAR_PASSIVES.has(word) || /ed$/.test(word)) {
      hits.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  return hits;
}

/**
 * Paper quality metrics. Descriptive feedback, not a validated grade.
 */
export function qualityReport(text) {
  const sentences = splitSentences(text);
  const tokens = tokenize(text);
  const paragraphs = splitParagraphs(text);
  const read = readability(text);
  const citations = findCitations(text);
  const passive = passiveVoice(text);
  const headings = (text.match(/^#{1,6}\s.+$/gm) || []).length;

  const longSentences = sentences.filter((s) => tokenize(s.text).length > 35);
  const veryLong = sentences.filter((s) => tokenize(s.text).length > 50);
  const paraWords = paragraphs.map((p) => tokenize(p.text).length);
  const avgParaWords = paraWords.length ? paraWords.reduce((a, b) => a + b, 0) / paraWords.length : 0;
  const giantParas = paraWords.filter((n) => n > 250).length;

  const suggestions = [];
  if (read.enough && read.fleschReadingEase < 30) suggestions.push("Most sentences are long and dense. Shorter sentences with simpler words would make the argument easier to follow.");
  if (longSentences.length > sentences.length * 0.15 && sentences.length > 10) suggestions.push(`${longSentences.length} sentences exceed 35 words. Consider splitting the longest ones.`);
  if (passive.length > sentences.length * 0.4 && sentences.length > 10) suggestions.push("Passive voice appears in most sentences. Active voice usually sharpens academic prose.");
  if (citations.length === 0 && tokens.length > 400) suggestions.push("No in-text citations were detected. Check your citation style guide.");
  if (citations.length > 0 && citations.length < 3 && tokens.length > 800) suggestions.push("Only a few citations were found for a paper of this length. Verify against your reference list.");
  if (avgParaWords > 220) suggestions.push("Average paragraphs are long. One idea per paragraph is easier to review.");
  if (giantParas > 0) suggestions.push(`${giantParas} paragraph${giantParas > 1 ? "s are" : " is"} over 250 words. Consider breaking ${giantParas > 1 ? "them" : "it"} up.`);
  if (headings === 0 && tokens.length > 1500) suggestions.push("No headings found in a long paper. Section headings help readers navigate.");
  if (!read.enough && tokens.length > 0) suggestions.push("The text is too short for readability statistics. At least 50 words are needed.");

  return {
    wordCount: tokens.length,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    headingCount: headings,
    readability: read,
    longSentences: longSentences.length,
    veryLongSentences: veryLong.length,
    passiveCount: passive.length,
    passiveShare: sentences.length ? passive.length / sentences.length : 0,
    citations,
    avgParagraphWords: Math.round(avgParaWords),
    suggestions,
  };
}

/** Everything in one pass. */
export function analyze(text, references = []) {
  return {
    similarity: similarityReport(text, references),
    style: styleIndicators(text),
    quality: qualityReport(text),
  };
}
