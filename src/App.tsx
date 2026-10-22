import { useCallback, useMemo, useRef, useState } from "react";
import { analyze, SAMPLE_REFERENCES, similarityReport } from "../shared/paper-core.mjs";

type RefDoc = { id: string; title: string; text: string; builtin?: boolean };

const fmtPct = (n: number | null | undefined) => (n == null ? "–" : `${n.toFixed(1)}%`);

export default function App() {
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<RefDoc[]>(SAMPLE_REFERENCES.map((r) => ({ ...r, builtin: true })));
  const [useSamples, setUseSamples] = useState(true);
  const [tab, setTab] = useState<"overview" | "similarity" | "style" | "quality">("overview");
  const [report, setReport] = useState<ReturnType<typeof analyze> | null>(null);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const paperFile = useRef<HTMLInputElement>(null);
  const refFile = useRef<HTMLInputElement>(null);

  const activeRefs = useMemo(() => refs.filter((r) => r.builtin === useSamples || !r.builtin), [refs, useSamples]);

  const run = useCallback(() => {
    if (!text.trim()) return;
    setReport(analyze(text, activeRefs));
    setRanAt(Date.now());
    setTab("overview");
  }, [text, activeRefs]);

  const readPaper = async (f: File) => {
    setText(await f.text());
    setReport(null);
  };

  const addRefs = async (files: FileList) => {
    const loaded: RefDoc[] = [];
    for (const f of Array.from(files)) {
      loaded.push({ id: `user-${f.name}-${loaded.length}`, title: f.name, text: await f.text() });
    }
    setRefs((r) => [...r, ...loaded]);
    setReport(null);
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="page">
      <header className="nav">
        <span className="brand">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <circle cx="14" cy="14" r="10.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <path d="M22 22l7 7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
            <path d="M9 14.5l3.5 3.5 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          PaperLens
        </span>
        <span className="tagline">Check a draft before you submit it</span>
      </header>

      <main>
        <section className="intro">
          <h1>Read your paper the way a reviewer might.</h1>
          <p>
            Paste or upload a draft and PaperLens reports overlapping text against references you choose, experimental writing-style indicators, and concrete quality
            feedback on readability and citations. Everything runs in your browser; nothing is uploaded or stored.
          </p>
          <p className="muted small">
            PaperLens is an independent study tool, not Turnitin, and it cannot search the internet or academic databases. Its style indicators are descriptive statistics,
            not proof of who wrote a text.
          </p>
        </section>

        <section className="editor card" aria-labelledby="paper-label">
          <div className="editor-head">
            <label id="paper-label" htmlFor="paper" className="field-label">
              Your paper
            </label>
            <div className="editor-actions">
              <button type="button" className="btn-ghost" onClick={() => paperFile.current?.click()}>
                Upload .txt / .md
              </button>
              <input ref={paperFile} type="file" hidden accept=".txt,.md,.markdown,text/plain" onChange={(e) => e.target.files?.[0] && void readPaper(e.target.files[0])} />
              <span className="muted small tabular">{words} words</span>
            </div>
          </div>
          <textarea
            id="paper"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste your essay, report or thesis chapter here…"
            spellCheck={false}
          />

          <details className="refs">
            <summary>
              References to compare against <span className="muted">({activeRefs.length})</span>
            </summary>
            <div className="refs-body">
              <label className="check">
                <input type="checkbox" checked={useSamples} onChange={(e) => setUseSamples(e.target.checked)} />
                Include the {SAMPLE_REFERENCES.length} bundled sample texts (useful for a quick demo)
              </label>
              <ul className="ref-list">
                {activeRefs.map((r) => (
                  <li key={r.id}>
                    <span className="ref-title">{r.title}</span>
                    {!r.builtin && (
                      <button type="button" className="btn-link" onClick={() => setRefs((all) => all.filter((x) => x.id !== r.id))}>
                        remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="ref-add">
                <button type="button" className="btn-ghost" onClick={() => refFile.current?.click()}>
                  Add reference files
                </button>
                <input ref={refFile} type="file" hidden multiple accept=".txt,.md,.markdown,text/plain" onChange={(e) => e.target.files?.length && void addRefs(e.target.files)} />
                <span className="muted small">Class notes, a friend's draft, sources you paraphrased — any plain text.</span>
              </div>
            </div>
          </details>

          <div className="run-row">
            <button type="button" className="btn-primary btn-lg" onClick={run} disabled={!text.trim()}>
              Analyze paper
            </button>
            {ranAt && report && <span className="muted small">Checked locally {new Date(ranAt).toLocaleTimeString()}</span>}
          </div>
        </section>

        {report && (
          <section className="report" aria-label="Report">
            <nav className="tabs" role="tablist" aria-label="Report sections">
              {([
                ["overview", "Overview"],
                ["similarity", "Similarity"],
                ["style", "Writing style"],
                ["quality", "Quality"],
              ] as const).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </nav>

            {tab === "overview" && <Overview r={report} text={text} />}
            {tab === "similarity" && <Similarity r={report.similarity} text={text} />}
            {tab === "style" && <Style r={report.style} />}
            {tab === "quality" && <Quality r={report.quality} />}
          </section>
        )}
      </main>

      <footer className="foot">
        <span>PaperLens · runs entirely in your browser</span>
        <span className="muted">
          Not affiliated with Turnitin. Similarity is computed only against the references you provide; style indicators are experimental statistics, not authorship verdicts.
        </span>
      </footer>
    </div>
  );
}

/* ---------------- Overview ---------------- */

function Overview({ r, text }: { r: ReturnType<typeof analyze>; text: string }) {
  const { similarity, style, quality } = r;
  const tone = similarity.percent >= 25 ? "bad" : similarity.percent >= 10 ? "warn" : "good";
  return (
    <div className="cards">
      <div className={`card stat ${tone}`}>
        <span className="stat-label">Similarity</span>
        <strong className="big tabular">{fmtPct(similarity.percent)}</strong>
        <span className="muted">
          {similarity.percent === 0
            ? `No overlapping passages found in ${similarity.referenceCount} reference${similarity.referenceCount === 1 ? "" : "s"}.`
            : `Matched against ${similarity.referenceCount} reference${similarity.referenceCount === 1 ? "" : "s"} you provided.`}
        </span>
        {similarity.selfRepetition.percent > 1 && <span className="flag">Also: {fmtPct(similarity.selfRepetition.percent)} repeated text within the paper</span>}
      </div>
      <div className="card stat">
        <span className="stat-label">Style indicators</span>
        <strong className="big">{style.commonPhrases.length} flags</strong>
        <span className="muted">
          {style.sentenceLength
            ? `Sentence lengths ${style.sentenceLength.cv < 0.25 ? "are unusually uniform" : "vary normally"}; ${style.starterRepetition.sentenceShare > 0.25 ? "many sentences open with the same connectors" : "sentence openings vary"}.`
            : "Text is too short for sentence statistics."}
        </span>
        <span className="flag">Experimental: descriptive only, no authorship verdict.</span>
      </div>
      <div className="card stat">
        <span className="stat-label">Readability</span>
        <strong className="big tabular">{quality.readability.fleschReadingEase != null ? quality.readability.fleschReadingEase.toFixed(0) : "–"}</strong>
        <span className="muted">
          {quality.readability.enough
            ? `Flesch reading ease; grade level ${quality.readability.fleschKincaidGrade ?? "–"}. ${quality.citations.length} citations detected.`
            : "At least 50 words are needed."}
        </span>
        <span className="flag">{quality.suggestions.length} suggestion{quality.suggestions.length === 1 ? "" : "s"} in the Quality tab</span>
      </div>
      <div className="card wide">
        <h3>What to do next</h3>
        <ul className="next">
          <li>
            Open <strong>Similarity</strong> to see each overlapping passage next to its source and rewrite the ones you meant to paraphrase.
          </li>
          <li>
            Open <strong>Writing style</strong> for statistics that reviewers and editors associate with polished prose, including uniformity of sentence length.
          </li>
          <li>
            Open <strong>Quality</strong> for readability scores, passive-voice density, citation detection and specific suggestions for this draft.
          </li>
        </ul>
        <p className="muted small">{text.trim().split(/\s+/).length} words analyzed locally.</p>
      </div>
    </div>
  );
}

/* ---------------- Similarity ---------------- */

const SOURCE_COLORS = ["#c0392b", "#8e44ad", "#16a085", "#d35400", "#2c5f8a", "#6b6b6b"];

function Similarity({ r, text }: { r: ReturnType<typeof similarityReport>; text: string }) {
  const colorOf = new Map(r.perSource.map((s, i) => [s.refId, SOURCE_COLORS[i % SOURCE_COLORS.length]]));
  const marks = [...r.runs, ...r.selfRepetition.runs.map((s) => ({ ...s, refId: "__self" }))]
    .sort((a, b) => a.start - b.start);
  const segments: { text: string; refId?: string }[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start < cursor) continue; // overlaps: first match wins
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start) });
    segments.push({ text: text.slice(m.start, m.end), refId: m.refId });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>Similarity: {fmtPct(r.percent)}</h3>
          <p className="muted">
            {r.matchedWords} of {r.totalWords} words appear in your references in the same order. This is a comparison against {r.referenceCount} document
            {r.referenceCount === 1 ? "" : "s"} only, not a database or internet search.
          </p>
        </div>
      </div>

      {r.percent === 0 && r.selfRepetition.percent === 0 && <p className="empty">No overlapping passages were found.</p>}

      {r.perSource.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Source</th>
              <th className="num">Matched words</th>
              <th className="num">Share of paper</th>
            </tr>
          </thead>
          <tbody>
            {r.perSource.map((s) => (
              <tr key={s.refId}>
                <td>
                  <i className="dot" style={{ background: colorOf.get(s.refId) }} />
                  {s.title}
                </td>
                <td className="num tabular">{s.words}</td>
                <td className="num tabular">{fmtPct(s.percentOfPaper)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {r.selfRepetition.percent > 0 && (
        <p className="note">
          Repeated text inside the paper itself: {fmtPct(r.selfRepetition.percent)} (highlighted in gray below).
        </p>
      )}

      <h4 className="sub">Your paper, highlighted</h4>
      <div className="marked">
        {segments.map((s, i) =>
          s.refId ? (
            <mark key={i} style={{ background: s.refId === "__self" ? "#d9d9d9" : `${colorOf.get(s.refId)}22`, borderBottom: `2px solid ${s.refId === "__self" ? "#999" : colorOf.get(s.refId)}` }}>
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>

      {r.runs.length > 0 && (
        <>
          <h4 className="sub">Matched passages</h4>
          <ul className="matches">
            {r.runs.map((run, i) => (
              <li key={i}>
                <i className="dot" style={{ background: colorOf.get(run.refId) }} />
                <div>
                  <p className="quote">“{run.excerpt.slice(0, 220)}{run.excerpt.length > 220 ? "…" : ""}”</p>
                  <p className="muted small">
                    {run.wordCount} words · from {r.perSource.find((s) => s.refId === run.refId)?.title}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ---------------- Writing style ---------------- */

function Style({ r }: { r: ReturnType<typeof analyze>["style"] }) {
  const cv = r.sentenceLength;
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>Writing-style indicators</h3>
          <p className="muted">
            Experimental statistics. They describe the text and cannot show who or what wrote it. No AI-authorship probability is computed, and none should be inferred.
          </p>
        </div>
      </div>

      <div className="style-grid">
        <Indicator
          title="Sentence-length variation"
          value={cv ? cv.cv.toFixed(2) : "–"}
          desc={
            cv
              ? `Average sentence ${cv.mean.toFixed(0)} words. Variation coefficient ${cv.cv.toFixed(2)} — ${
                  cv.cv < 0.25 ? "unusually uniform; human writing typically varies more" : "within the typical range for human writing"
                }.`
              : "At least five sentences are needed."
          }
          flag={cv ? cv.cv < 0.25 : false}
        />
        <Indicator
          title="Vocabulary variety"
          value={r.typeTokenRatio ? r.typeTokenRatio.toFixed(2) : "–"}
          desc={
            r.typeTokenRatio
              ? `Unique words / total words. ${r.typeTokenRatio < 0.4 && r.wordCount > 300 ? "Low for a paper of this length; the same terms repeat heavily." : "Within a normal range."}`
              : "–"
          }
          flag={r.typeTokenRatio != null && r.typeTokenRatio < 0.4 && r.wordCount > 300}
        />
        <Indicator
          title="Formulaic phrases"
          value={String(r.commonPhrases.length)}
          desc={
            r.commonPhrases.length
              ? `Found: ${r.commonPhrases.map((p) => `“${p}”`).join(", ")}. These appear often in generic writing.`
              : "None of the commonly recycled phrases were found."
          }
          flag={r.commonPhrases.length > 0}
        />
        <Indicator
          title="Repeated sentence openers"
          value={fmtPct(r.starterRepetition.sentenceShare * 100)}
          desc={
            r.starterRepetition.total
              ? `${r.starterRepetition.total} sentences begin with connectors like “furthermore” or “however” (${Object.entries(r.starterRepetition.counts)
                  .map(([k, v]) => `${k} ×${v}`)
                  .join(", ")}). Varying openings reads more naturally.`
              : "No repeated connector openers."
          }
          flag={r.starterRepetition.sentenceShare > 0.25}
        />
        <Indicator
          title="Contractions"
          value={String(r.contractions)}
          desc={r.contractions > 0 ? "Contractions are informal in most academic styles; check your style guide." : "No contractions found."}
          flag={false}
        />
        <Indicator
          title="Punctuation variety"
          value={`${r.punctuationVariety.emDashes} — · ${r.punctuationVariety.semicolons} ; · ${r.punctuationVariety.exclamations} !`}
          desc="Formal academic prose uses few exclamation marks. Em dashes and semicolons indicate varied sentence structure."
          flag={r.punctuationVariety.exclamations > 2}
        />
      </div>
      <p className="note">
        Why no “AI percentage”? Detectors that output such numbers are unreliable enough that several universities have stopped using them, and false accusations harm students.
        These indicators are shared so you can judge your own writing, not to judge you.
      </p>
    </div>
  );
}

function Indicator({ title, value, desc, flag }: { title: string; value: string; desc: string; flag: boolean }) {
  return (
    <div className={`card indicator ${flag ? "flagged" : ""}`}>
      <span className="stat-label">{title}</span>
      <strong className="tabular">{value}</strong>
      <p className="muted small">{desc}</p>
    </div>
  );
}

/* ---------------- Quality ---------------- */

function Quality({ r }: { r: ReturnType<typeof analyze>["quality"] }) {
  const read = r.readability;
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>Paper quality</h3>
          <p className="muted">Descriptive metrics and limited feedback, not a grade.</p>
        </div>
      </div>
      <div className="cards">
        <div className="card stat">
          <span className="stat-label">Words / sentences / paragraphs</span>
          <strong className="tabular">
            {r.wordCount} / {r.sentenceCount} / {r.paragraphCount}
          </strong>
          <span className="muted small">{r.headingCount} heading{r.headingCount === 1 ? "" : "s"} detected</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Flesch reading ease</span>
          <strong className="big tabular">{read.fleschReadingEase != null ? read.fleschReadingEase.toFixed(1) : "–"}</strong>
          <span className="muted small">{read.fleschKincaidGrade != null ? `Grade level ${read.fleschKincaidGrade} (Flesch–Kincaid)` : "Needs at least 50 words"}</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Long sentences</span>
          <strong className="big tabular">{r.longSentences}</strong>
          <span className="muted small">
            {r.veryLongSentences} over 50 words; {fmtPct(r.passiveShare * 100)} of sentences contain passive voice
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">Citations detected</span>
          <strong className="big tabular">{r.citations.length}</strong>
          <span className="muted small">
            {r.citations.length
              ? `Styles seen: ${[...new Set(r.citations.map((c) => c.style))].join(", ")}`
              : "None found by pattern matching; verify your reference list"}
          </span>
        </div>
      </div>

      {r.suggestions.length > 0 && (
        <>
          <h4 className="sub">Suggestions</h4>
          <ul className="suggestions">
            {r.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {r.citations.length > 0 && (
        <>
          <h4 className="sub">Citations found</h4>
          <ul className="citations">
            {r.citations.map((c, i) => (
              <li key={i}>
                <span className="pill">{c.style}</span> <code>{c.text}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
