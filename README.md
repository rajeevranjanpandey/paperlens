# PaperLens

[![Deploy to GitHub Pages](https://github.com/rajeevranjanpandey/paperlens/actions/workflows/pages.yml/badge.svg)](https://github.com/rajeevranjanpandey/paperlens/actions/workflows/pages.yml) [![Tests](https://img.shields.io/badge/tests-66%2F66%20passing-brightgreen)](tests)

Check a draft before you submit it. Paste or upload a paper (.txt, .md, .pdf or .docx) and PaperLens reports the following, entirely in your browser. An optional rewrite tool (bring your own IFM key) is the single exception, described below.

| Check | What it does | How it works |
|---|---|---|
| Repetition | Finds passages that repeat inside the paper itself — doubled phrases, recycled sentences — and highlights them in place | 7-word shingle matching of the paper against itself; no references, no uploads |
| Writing style | Experimental indicators: sentence-length uniformity, vocabulary variety, formulaic phrases, repeated sentence openers | Pure statistics computed from the text. No AI-authorship probability, by design |
| Quality | Flesch reading ease and grade level, long-sentence and passive-voice counts, in-text citation detection, and concrete suggestions | Readability formulas, pattern matching and simple heuristics |
| Citation cross-check | In-text citations with no reference entry, and reference entries never cited, in author-year and IEEE styles | Heading detection, surname/year extraction and comparison |
| Citation check | Every reference split into fields (authors, year, title, venue, DOI) and checked field by field: valid DOI syntax, plausible year, duplicates, list ordering, cross-check — with one-click DOI and Google Scholar verification links | Local format and plausibility signals only; PaperLens cannot query academic databases, so a flag means "verify this field", never "this source is fake". Tolerates `Selected Technical References` headings, `[R1]` labels, corporate authors and wrapped entries |
| Academic tone | Informal wording, second-person address and stray exclamation marks, each with a suggested fix | Curated pattern list with positions |
| Inline flags | Tone and recycled-phrase flags highlighted directly inside your paper text | Overlap-safe span rendering in the Quality tab |

## Rewrite with IFM (optional)

The one feature that talks to a network — and it is part of the same single flow: paste or upload your draft, add your IFM key, press **Analyze & Rewrite**. The checks and the rewrite run together; there are no modes to choose. The methodology follows the published pipelines of sites like superhumanizer.ai and humanizethis.io — split, lock, rewrite, verify — with the verification done mechanically instead of promised:

### Getting an IFM key

1. Go to the IFM Platform API keys page — [platform.ifm.ai/api-keys](https://platform.ifm.ai/api-keys) — and sign in (create a free IFM account there if you don't have one).
2. Create a new API key and copy it immediately: it starts with `IFM-v1_` and the full key is shown only once, so store it somewhere safe.
3. Paste it into the **IFM API key** field in PaperLens. The default model (`IFM/K2-Horizon-375B-A23B`) is pre-filled — no other setup is needed.

Official reference: the [IFM Quickstart](https://docs.ifm.ai/docs/quickstart.md). Every other PaperLens check — style, quality, citations, repetition — runs fully offline and never needs a key.

- **Protected spans.** Numbers, dates, URLs, emails and citations are swapped for placeholders before the model sees the text and restored afterwards.
- **Four candidates per paragraph.** Each paragraph is rewritten four times (two parallel waves, varied temperatures); candidates must keep every protected span exactly, keep the document's number counts identical (multiset check), stay within a length band, and clear a rewrite-depth gate — a candidate that keeps 70% or more of the original's words in order counts as a trim, not a rewrite, and is rejected. Survivors are ranked deepest-first before the judge and drift checks. Rejection triggers one sterner retry.
- **Judge + drift check.** A judge call arbitrates between the deepest passing candidates, and a drift check can still reject each in turn. If every candidate drifts, the pipeline escalates before giving up — a fidelity-first regeneration, then a close paraphrase (structure changes only), and for paragraphs with no facts to protect, a drift-approved near-threshold paraphrase as a last resort. A paragraph whose candidates all fail is returned unchanged.
- **Rate-limit resilience.** The IFM provider retries transient failures (HTTP 429, 5xx, network errors, empty completions) with backoff — 1.5s, 4s, 10s, 20s — so a quota spike mid-paper no longer kills paragraphs. Cancelling still stops everything immediately.
- **Scale guardrails.** A progress bar counts blocks as they finish, with a Cancel button that stops new work (finished paragraphs are kept, the rest are marked "not run (cancelled)"). Documents over 20 paragraphs ask first, with an estimate of the model calls involved (~7 per paragraph) — a full paper can mean hundreds of calls against your own quota.
- **Your key, your browser.** You paste your own IFM API key; it is stored only in your browser's localStorage and sent only to api.ifm.ai (whose CORS policy allows calls from this site). PaperLens has no backend and never sees it. Without a key, the checks still run on their own.
- **No authorship scores.** The output reports descriptive before/after statistics (word counts, sentence-length variation), never an "AI probability" — the same philosophy as the style indicators.

The pipeline lives in `shared/humanizer-core.mjs` with the provider in `shared/ifm-provider.mjs`; both are dependency-free and unit-tested with a mock model, and the verification layer was hardened against a real 6,300-word grant proposal (a repeated figure dropped by an early rewrite is what the multiset check now catches).

## What this is not

PaperLens is a study tool, not Turnitin. It cannot search the internet or academic databases, and its repetition check compares a paper only against itself, so a clean result here proves nothing about the wider world. Its style indicators describe a text; they cannot show who or what wrote it, and no verdict should be inferred from them. Detectors that output an "AI percentage" are unreliable enough that several universities have stopped using them, and false accusations harm students.

Nothing you paste for the checks is uploaded or stored. There is no backend, no analytics and no account. The optional rewrite tool is the exception: only when you press Humanize does your draft go to the IFM API, under your own key.

## Run it

```bash
npm install
npm test       # 76 tests: engine, extraction, citations, humanizer (incl. rewrite-depth gate), provider, adversarial, guardrails
npm run dev    # http://127.0.0.1:5173
npm run build  # static output in dist/
```

A live copy is built to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

## Try it in 30 seconds

1. Open the app and paste any paragraph twice into the paper box.
2. Press Analyze & Rewrite (or just run the checks). The Repetition tab shows the repeated passage highlighted.
3. Replace the text with your own writing and press it again to see a clean report.

## Structure

```text
shared/paper-core.mjs     Analysis engine: tokenizer, shingle repetition, style
                          indicators, readability, citations, passive voice.
shared/extract-text.mjs   Upload parsing: DOCX via fflate + document.xml,
                          PDF via pdf.js (loaded only when a PDF is opened).
shared/citation-check.mjs Field-by-field reference checks + cross-check
                          (tolerant section/entry parsing, DOI and
                          plausibility signals, Scholar/DOI verify links).
shared/humanizer-core.mjs Rewrite pipeline: block parsing, protected spans,
                          verification (incl. a rewrite-depth gate that
                          rejects near-verbatim trims), judge passes;
                          provider-agnostic.
shared/ifm-provider.mjs   IFM chat-completions provider (OpenAI-compatible).
src/App.tsx               The interface: editor, a standalone Citation check
                          section on the main page (runs on the paper alone),
                          report tabs (incl. Citations), and the rewrite panel.
tests/                    76 tests: engine, style checks, DOCX/PDF extraction,
                          citation check incl. a real-world grant-proposal
                          reference list, humanizer protection/verification,
                          and the IFM provider against a stubbed fetch.
```

## Study workflow

- **Draft auto-save.** The paper is saved to localStorage as you type, so a refresh or accidental close does not lose work. A "clear" link removes it.
- **Word target.** Set the essay length (say 2000 words) and a progress bar tracks how close the draft is.
- **Recent checks.** The last eight checks are stored locally with word count, repetition and flags, so you can see progress across revisions.
- **Download report.** The full report exports as a plain-text file, generated in the browser.

## Uploads

DOCX files are unzipped in the browser and read from word/document.xml, with paragraph breaks and XML entities preserved. PDFs are parsed with pdf.js page by page; a scanned PDF with no text layer is detected and reported instead of silently checking an empty document. Both parsers run entirely in the browser.

## Extending it

The engine in `shared/paper-core.mjs` is plain JavaScript with no dependencies, so you can reuse it in a CLI, an LMS plugin or a server. Sensible next steps if you want to go further:

- Group tone and style flags by paragraph for inline highlighting.
- Add docx/pdf parsing before analysis (e.g. mammoth or pdf.js).
- Persist reports locally with IndexedDB if you want history.

MIT licensed. Not affiliated with Turnitin. The repetition check compares a paper only against itself; style indicators are experimental statistics, not authorship verdicts.
