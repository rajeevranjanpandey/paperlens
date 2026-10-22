# PaperLens

[![Deploy to GitHub Pages](https://github.com/rajeevranjanpandey/paperlens/actions/workflows/pages.yml/badge.svg)](https://github.com/rajeevranjanpandey/paperlens/actions/workflows/pages.yml) [![Tests](https://img.shields.io/badge/tests-26%2F26%20passing-brightgreen)](tests)

Check a draft before you submit it. Paste or upload a paper (.txt, .md, .pdf or .docx) and PaperLens reports the following, entirely in your browser:

| Check | What it does | How it works |
|---|---|---|
| Similarity | Finds passages that overlap with references you choose, and shows each match next to its source | 7-word shingle matching against the bundled sample texts or any files you add (.txt, .md, .pdf, .docx) |
| Writing style | Experimental indicators: sentence-length uniformity, vocabulary variety, formulaic phrases, repeated sentence openers | Pure statistics computed from the text. No AI-authorship probability, by design |
| Quality | Flesch reading ease and grade level, long-sentence and passive-voice counts, in-text citation detection, and concrete suggestions | Readability formulas, pattern matching and simple heuristics |
| Citation cross-check | In-text citations with no reference entry, and reference entries never cited, in author-year and IEEE styles | Heading detection, surname/year extraction and comparison |
| Academic tone | Informal wording, second-person address and stray exclamation marks, each with a suggested fix | Curated pattern list with positions |

## What this is not

PaperLens is a study tool, not Turnitin. It cannot search the internet or academic databases, so a 0% similarity here proves nothing about the wider world. Its style indicators describe a text; they cannot show who or what wrote it, and no verdict should be inferred from them. Detectors that output an "AI percentage" are unreliable enough that several universities have stopped using them, and false accusations harm students.

Nothing you paste is uploaded or stored. There is no backend, no analytics and no account.

## Run it

```bash
npm install
npm test       # 14 engine tests
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
src/App.tsx               The interface: editor, reference manager, report tabs.
tests/                    Engine tests (20), including copied vs original text,
                          no double counting, empty inputs, user references,
                          DOCX extraction with entities, and binary rejection.
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
