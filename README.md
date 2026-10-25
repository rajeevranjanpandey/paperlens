# PaperLens

[![Deploy to GitHub Pages](https://github.com/rajeevranjanpandey/paperlens/actions/workflows/pages.yml/badge.svg)](https://github.com/rajeevranjanpandey/paperlens/actions/workflows/pages.yml) [![Tests](https://img.shields.io/badge/tests-55%2F55%20passing-brightgreen)](tests)

Check a draft before you submit it. Paste or upload a paper (.txt, .md, .pdf or .docx) and PaperLens reports the following, entirely in your browser. An optional rewrite tool (bring your own IFM key) is the single exception, described below.

| Check | What it does | How it works |
|---|---|---|
| Similarity | Finds passages that overlap with references you choose, and shows each match next to its source | 7-word shingle matching against the bundled sample texts or any files you add (.txt, .md, .pdf, .docx) |
| Writing style | Experimental indicators: sentence-length uniformity, vocabulary variety, formulaic phrases, repeated sentence openers | Pure statistics computed from the text. No AI-authorship probability, by design |
| Quality | Flesch reading ease and grade level, long-sentence and passive-voice counts, in-text citation detection, and concrete suggestions | Readability formulas, pattern matching and simple heuristics |
| Citation cross-check | In-text citations with no reference entry, and reference entries never cited, in author-year and IEEE styles | Heading detection, surname/year extraction and comparison |
| Citation check | Every reference split into fields (authors, year, title, venue, DOI) and checked field by field: valid DOI syntax, plausible year, duplicates, list ordering, cross-check — with one-click DOI and Google Scholar verification links | Local format and plausibility signals only; PaperLens cannot query academic databases, so a flag means "verify this field", never "this source is fake". Tolerates `Selected Technical References` headings, `[R1]` labels, corporate authors and wrapped entries |
| Academic tone | Informal wording, second-person address and stray exclamation marks, each with a suggested fix | Curated pattern list with positions |
| Inline flags | Tone and recycled-phrase flags highlighted directly inside your paper text | Overlap-safe span rendering in the Quality tab |

## Rewrite with IFM (optional)

The one feature that talks to a network: a paragraph-by-paragraph rewrite powered by the [IFM](https://api.ifm.ai) API (default model `IFM/K2-Horizon-375B-A23B`), inspired by one-click humanizer tools but built around verification instead of promises:

- **Protected spans.** Numbers, dates, URLs, emails and citations are swapped for placeholders before the model sees the text and restored afterwards.
- **Mechanical verification.** Every candidate must keep every protected span exactly, keep the document's number counts identical (multiset check), and stay within a length band — otherwise it is rejected.
- **Modes.** Standard (one pass), Ultra (checks plus retries with a sterner prompt), Premium (two candidates, a judge picks the more faithful one, then a drift check). A paragraph whose candidates all fail is returned unchanged.
- **Your key, your browser.** You paste your own IFM API key; it is stored only in your browser's localStorage and sent only to api.ifm.ai (whose CORS policy allows calls from this site). PaperLens has no backend and never sees it.
- **No authorship scores.** The panel reports descriptive before/after statistics (word counts, sentence-length variation), never an "AI probability" — the same philosophy as the style indicators.

The pipeline lives in `shared/humanizer-core.mjs` with the provider in `shared/ifm-provider.mjs`; both are dependency-free and unit-tested with a mock model, and the verification layer was hardened against a real 6,300-word grant proposal (a repeated figure dropped by an early rewrite is what the multiset check now catches).

## What this is not

PaperLens is a study tool, not Turnitin. It cannot search the internet or academic databases, so a 0% similarity here proves nothing about the wider world. Its style indicators describe a text; they cannot show who or what wrote it, and no verdict should be inferred from them. Detectors that output an "AI percentage" are unreliable enough that several universities have stopped using them, and false accusations harm students.

Nothing you paste for the checks is uploaded or stored. There is no backend, no analytics and no account. The optional rewrite tool is the exception: only when you press Humanize does your draft go to the IFM API, under your own key.

## Run it

```bash
npm install
npm test       # 55 tests: engine, extraction, citation check, humanizer, IFM provider
npm run dev    # http://127.0.0.1:5173
npm run build  # static output in dist/
```

A live copy is built to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

## Try it in 30 seconds

1. Open the app, expand References, and leave the bundled sample texts checked.
2. Copy the first paragraph of the climate sample (see `shared/paper-core.mjs`) into the paper box.
3. Press Analyze paper. The Similarity tab shows the passage highlighted with its source.
4. Replace the text with your own writing and press Analyze again to see a clean report.

## Structure

```text
shared/paper-core.mjs     Analysis engine: tokenizer, shingle similarity, style
                          indicators, readability, citations, passive voice.
shared/extract-text.mjs   Upload parsing: DOCX via fflate + document.xml,
                          PDF via pdf.js (loaded only when a PDF is opened).
shared/citation-check.mjs Field-by-field reference checks + cross-check
                          (tolerant section/entry parsing, DOI and
                          plausibility signals, Scholar/DOI verify links).
shared/humanizer-core.mjs Rewrite pipeline: block parsing, protected spans,
                          verification, judge passes; provider-agnostic.
shared/ifm-provider.mjs   IFM chat-completions provider (OpenAI-compatible).
src/App.tsx               The interface: editor, reference manager, report
                          tabs (incl. Citations), and the rewrite panel.
tests/                    55 tests: engine, style checks, DOCX/PDF extraction,
                          citation check incl. a real-world grant-proposal
                          reference list, humanizer protection/verification,
                          and the IFM provider against a stubbed fetch.
```

## Study workflow

- **Draft auto-save.** The paper is saved to localStorage as you type, so a refresh or accidental close does not lose work. A "clear" link removes it.
- **Word target.** Set the essay length (say 2000 words) and a progress bar tracks how close the draft is.
- **Recent checks.** The last eight checks are stored locally with word count, similarity and flags, so you can see progress across revisions.
- **Download report.** The full report exports as a plain-text file, generated in the browser.

## Uploads

DOCX files are unzipped in the browser and read from word/document.xml, with paragraph breaks and XML entities preserved. PDFs are parsed with pdf.js page by page; a scanned PDF with no text layer is detected and reported instead of silently checking an empty document. Both parsers also work for reference files.

## Extending it

The engine in `shared/paper-core.mjs` is plain JavaScript with no dependencies, so you can reuse it in a CLI, an LMS plugin or a server. Sensible next steps if you want to go further:

- Add real reference corpora (your class's past submissions, with consent).
- Group tone and style flags by paragraph for inline highlighting.
- Add docx/pdf parsing before analysis (e.g. mammoth or pdf.js).
- Persist reports locally with IndexedDB if you want history.

MIT licensed. Not affiliated with Turnitin. Similarity is computed only against references you provide; style indicators are experimental statistics, not authorship verdicts.
