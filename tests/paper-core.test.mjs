import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SAMPLE_REFERENCES, similarityReport, styleIndicators, qualityReport,
  readability, findCitations, passiveVoice, splitSentences, tokenize, analyze,
} from "../shared/paper-core.mjs";

const climate = SAMPLE_REFERENCES.find((r) => r.id === "ref-climate");
const copiedPara = `Coastal cities face a double burden as the climate warms. Sea levels rise slowly
enough to ignore in daily life, yet fast enough to overwhelm drainage systems built for a calmer century.
Adaptation therefore tends to arrive as a reaction to disaster rather than as a planned investment.`;
const original = `This paper argues that university cloud budgets are best understood as stories that
organizations tell themselves about the future. I interviewed eleven administrators across three campuses
and found that the forecasts mattered less than the rituals of forecasting. Every spring, someone rebuilt the
spreadsheet; every autumn, the numbers were wrong in ways nobody had expected, and nobody was surprised.
The interesting question is not why the estimates failed but why the practice survived its failures.`;

test("copied passage is matched to its source", () => {
  const r = similarityReport(copiedPara, SAMPLE_REFERENCES);
  assert.equal(r.perSource.length, 1);
  assert.equal(r.perSource[0].refId, "ref-climate");
  assert.ok(r.percent > 60, `expected high similarity, got ${r.percent}`);
  assert.ok(r.runs.length >= 1);
  assert.ok(r.runs[0].wordCount >= 7);
});

test("original text matches nothing", () => {
  const r = similarityReport(original, SAMPLE_REFERENCES);
  assert.equal(r.percent, 0);
  assert.equal(r.runs.length, 0);
  assert.equal(r.perSource.length, 0);
});

test("matches are not double counted when sources share nothing", () => {
  const text = `${copiedPara} ${original}`;
  const r = similarityReport(text, SAMPLE_REFERENCES);
  // matched words should be roughly the copied paragraph only
  const copiedWords = tokenize(copiedPara).length;
  const total = tokenize(text).length;
  const expected = (copiedWords / total) * 100;
  assert.ok(Math.abs(r.percent - expected) < 8, `got ${r.percent}, expected ~${expected}`);
});

test("user-supplied references are used instead of samples", () => {
  const myRef = { id: "mine", title: "My reference", text: "The quick brown fox jumps over the lazy dog and then it rests under a tree all afternoon long." };
  const copy = "The quick brown fox jumps over the lazy dog and then it rests under a tree all afternoon long.";
  const r = similarityReport(copy, [myRef]);
  assert.ok(r.percent > 90);
  assert.equal(r.perSource[0].refId, "mine");
  const againstSamples = similarityReport(copy, SAMPLE_REFERENCES);
  assert.equal(againstSamples.percent, 0);
});

test("empty and short texts do not throw", () => {
  assert.equal(similarityReport("", SAMPLE_REFERENCES).percent, 0);
  assert.equal(similarityReport("Hello world.", SAMPLE_REFERENCES).percent, 0);
  const s = styleIndicators("Too short.");
  assert.equal(s.wordCount, 2);
  const q = qualityReport("");
  assert.equal(q.wordCount, 0);
});

test("self-repetition is detected", () => {
  const sentence = "The methodology section describes how the sample was selected and screened for eligibility.";
  const r = similarityReport(`${sentence} Some filler text follows here to separate the two copies. ${sentence}`, SAMPLE_REFERENCES);
  assert.ok(r.selfRepetition.runs.length >= 1);
  assert.ok(r.selfRepetition.percent > 0);
});

test("style indicators flag uniform, formulaic text", () => {
  const uniform = Array.from({ length: 12 }, (_, i) =>
    `Furthermore, it is important to note that the argument in point ${i} plays a crucial role in the overall discussion.`).join(" ");
  const style = styleIndicators(uniform);
  assert.ok(style.commonPhrases.length >= 3);
  assert.ok(style.starterRepetition.sentenceShare > 0.8);
  assert.ok(style.sentenceLength && style.sentenceLength.cv < 0.2);
  assert.equal(style.contractions, 0);
});

test("varied human-ish text scores differently on indicators", () => {
  const style = styleIndicators(original);
  assert.equal(style.commonPhrases.length, 0);
  assert.ok(style.starterRepetition.sentenceShare < 0.5);
});

test("readability behaves on simple and dense text", () => {
  const simple = ("The cat sat on the mat. It was a good day. The sun was out. Birds sang in the trees. " +
    "We walked home together. The end came fast. Kids played outside. Dogs ran around. It was nice. " +
    "The lake was calm. Boats floated by. Fish jumped once. Farmers waved at us. The road was long.").repeat(2);
  const r = readability(simple);
  assert.ok(r.enough && r.fleschReadingEase > 60);
  const dense = "Notwithstanding the methodological limitations enumerated hitherto, the epistemological considerations underpinning ontological commitments necessitate further hermeneutical investigation.";
  const r2 = readability(Array.from({ length: 4 }, () => dense).join(" "));
  assert.ok(r2.fleschReadingEase < 20);
});

test("citations are detected by style", () => {
  const text = `One study found strong effects (Smith, 2020). Another disagreed (Jones et al., 2019).
    The classic result [1] was later confirmed [2] and extended [3]. A further view (Brown 1998) exists.`;
  const cits = findCitations(text);
  const styles = new Set(cits.map((c) => c.style));
  assert.ok(styles.has("APA"));
  assert.ok(styles.has("IEEE"));
  assert.ok(cits.length >= 5);
  // lone bracket numbers are not citations
  const noCits = findCitations("The array was indexed as [1] in the code listing only.");
  assert.equal(noCits.filter((c) => c.style === "IEEE").length, 0);
});

test("passive voice is found and counted", () => {
  const p = passiveVoice("The data was collected by hand and the results were reviewed by two coders.");
  assert.ok(p.length >= 2);
});

test("quality report gives suggestions on a weak draft", () => {
  const longSentence = Array.from({ length: 40 }, (_, i) => `word number ${i}`).join(" ") + ".";
  const body = Array.from({ length: 10 }, () => longSentence).join(" ");
  const q = qualityReport(`${body}\n\n${body}`);
  assert.ok(q.longSentences > 0);
  assert.ok(q.suggestions.length >= 1);
});

test("analyze returns all three sections", () => {
  const a = analyze(original);
  assert.ok(a.similarity && a.style && a.quality);
  assert.equal(a.similarity.percent, 0);
});

test("sentence splitting keeps offsets inside the text", () => {
  const text = "First sentence here. Second one follows!";
  for (const s of splitSentences(text)) {
    assert.ok(text.slice(s.start, s.end).trim().length > 0);
  }
});
