import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyze, styleIndicators } from "../shared/paper-core.mjs";
import { extractText } from "../shared/extract-text.mjs";
import { humanizeText, proofreadText, estimateRewrite, estimateProofread } from "../shared/humanizer-core.mjs";
import { wordDiff, changedRatio } from "../shared/word-diff.mjs";
import { createIFMComplete, DEFAULT_IFM_MODEL } from "../shared/ifm-provider.mjs";
import { citationCheck } from "../shared/citation-check.mjs";
import { verifyReferences } from "../shared/reference-verify.mjs";

type HistEntry = { at: number; words: number; repetition: number; flags: number };

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be blocked in embedded previews */
  }
}
function clearDraft() {
  try {
    window.localStorage.removeItem("pl.draft");
  } catch {
    /* ignore */
  }
}

const fmtPct = (n: number | null | undefined) => (n == null ? "–" : `${n.toFixed(1)}%`);

// Status pill colour by outcome: green for a completed rewrite or
// proofread, neutral for text kept as-is, amber for blocks the run
// never reached.
const pillClass = (status: string) =>
  status.startsWith("rewritten") || status === "proofread"
    ? "pill pill-ok"
    : status === "not run (cancelled)"
      ? "pill pill-warn"
      : "pill pill-kept";

// A rewritten paragraph with the changed wording highlighted in green.
function HighlightedText({ original, output }: { original: string; output: string }) {
  const tokens = wordDiff(original, output);
  return (
    <>
      {tokens.map((t: any, k: number) => (
        <Fragment key={k}>
          {k > 0 ? " " : ""}
          {t.changed ? <mark className="mark-changed">{t.text}</mark> : t.text}
        </Fragment>
      ))}
    </>
  );
}

export default function App() {
  const [text, setText] = useState(() => loadJSON("pl.draft", ""));
  const [target, setTarget] = useState<number>(() => loadJSON("pl.target", 0) || 0);
  const [history, setHistory] = useState<HistEntry[]>(() => loadJSON("pl.history", [] as HistEntry[]));
  const [tab, setTab] = useState<"overview" | "repetition" | "style" | "quality" | "citations">("overview");
  const [report, setReport] = useState<ReturnType<typeof analyze> | null>(null);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [fileNote, setFileNote] = useState("");
  const [busy, setBusy] = useState(false);
  const paperFile = useRef<HTMLInputElement>(null);

  // Rewrite (optional, BYO IFM key): the only feature that calls a network API.
  const [ifmKey, setIfmKey] = useState<string>(() => loadJSON("pl.ifmKey", ""));
  const [ifmModel, setIfmModel] = useState<string>(() => loadJSON("pl.ifmModel", DEFAULT_IFM_MODEL));

  const [rwBusy, setRwBusy] = useState(false);
  const [rwError, setRwError] = useState("");
  const [rwResult, setRwResult] = useState<any>(null);
  const [rwAccepted, setRwAccepted] = useState<boolean[]>([]);
  const [rwCopied, setRwCopied] = useState(false);
  const [rwProgress, setRwProgress] = useState<{ done: number; total: number } | null>(null);
  const [rwConfirm, setRwConfirm] = useState(false);
  const [rwEstimate, setRwEstimate] = useState<{ blocks: number; paragraphs: number; approxCalls: number } | null>(null);
  // Which transform produced (or is producing) the result panel: the
  // breakdown, progress text and labels all adapt to it.
  const [rwMode, setRwMode] = useState<"rewrite" | "proofread">("rewrite");
  const [rwPendingMode, setRwPendingMode] = useState<"rewrite" | "proofread">("rewrite");
  const rwAbort = useRef<AbortController | null>(null);

  // Standalone citation check: a first-class section on the main page, not
  // buried inside the post-analysis report. It reads the reference list
  // inside the paper itself - no uploads, no IFM key.
  const [citText, setCitText] = useState<string | null>(null);
  const citSection = useRef<HTMLElement | null>(null);
  const runCitationCheck = () => {
    if (!text.trim()) return;
    setCitText(text);
    requestAnimationFrame(() => citSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const run = useCallback(() => {
    if (!text.trim()) return;
    const result = analyze(text, []);
    setReport(result);
    setRanAt(Date.now());
    setTab("overview");
    const entry: HistEntry = {
      at: Date.now(),
      words: result.quality.wordCount,
      repetition: Math.round(result.similarity.selfRepetition.percent * 10) / 10,
      flags: result.style.commonPhrases.length + result.tone.length,
    };
    setHistory((h) => {
      const next = [entry, ...h].slice(0, 8);
      saveJSON("pl.history", next);
      return next;
    });
  }, [text]);

  // Draft auto-save: the paper survives a refresh or an accidental close.
  useEffect(() => {
    const t = window.setTimeout(() => saveJSON("pl.draft", text), 600);
    return () => window.clearTimeout(t);
  }, [text]);

  const setTargetWords = (n: number) => {
    setTarget(n);
    saveJSON("pl.target", n);
  };

  const readPaper = async (f: File) => {
    setBusy(true);
    setFileNote("");
    try {
      const r = await extractText(f);
      if (r.error || !r.text) {
        setFileNote(r.error || "Nothing could be read from that file.");
      } else {
        setText(r.text);
        setReport(null);
        setFileNote(`${f.name} · ${r.kind === "docx" ? "Word" : r.kind === "pdf" ? "PDF" : "text"} file loaded`);
      }
    } catch (e: any) {
      setFileNote(`Could not read ${f.name}: ${e?.message || e}`);
    }
    setBusy(false);
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  const makeComplete = () => createIFMComplete({ apiKey: ifmKey.trim(), model: ifmModel.trim() || DEFAULT_IFM_MODEL });

  const runTransform = async (mode: "rewrite" | "proofread") => {
    setRwMode(mode);
    setRwBusy(true);
    setRwError("");
    const controller = new AbortController();
    rwAbort.current = controller;
    setRwProgress({ done: 0, total: (mode === "proofread" ? estimateProofread(text) : estimateRewrite(text)).blocks });
    try {
      const run = (mode === "proofread" ? proofreadText : humanizeText) as typeof humanizeText;
      const res = await run(text, {
        complete: makeComplete(),
        signal: controller.signal,
        onProgress: (done: number, total: number) => setRwProgress({ done, total }),
      });
      setRwResult(res);
      setRwAccepted(res.blocks.map((b: any) => b.status.startsWith("rewritten") || b.status === "proofread"));
    } catch (e: any) {
      setRwError(e?.message || String(e));
    }
    setRwProgress(null);
    setRwBusy(false);
  };

  const runRewrite = () => runTransform("rewrite");

  // Proofread: the cautious counterpart of the rewrite - same input,
  // same key and settings, but the core gates every correction so the
  // wording cannot drift from the original.
  const startProofread = () => {
    if (!text.trim()) return;
    if (!ifmKey.trim()) {
      setRwError(
        "Proofreading needs an IFM API key - add one in the key field above (the same key the rewrite uses). The checks run without a key; proofreading, like the rewrite, calls the model."
      );
      return;
    }
    const est = estimateProofread(text);
    if (est.paragraphs > 20) {
      setRwEstimate(est);
      setRwPendingMode("proofread");
      setRwConfirm(true);
      return;
    }
    void runTransform("proofread");
  };

  // One flow: run the local checks, and the rewrite too when a key is present.
  // Long documents (>20 paragraphs) ask first - a full paper can mean
  // hundreds of model calls against the user's own quota.
  const runAll = () => {
    run();
    if (!ifmKey.trim()) return;
    const est = estimateRewrite(text);
    if (est.paragraphs > 20) {
      setRwEstimate(est);
      setRwPendingMode("rewrite");
      setRwConfirm(true);
      return;
    }
    void runRewrite();
  };

  const redoBlock = async (i: number) => {
    if (!rwResult) return;
    setRwBusy(true);
    setRwError("");
    try {
      const run = (rwMode === "proofread" ? proofreadText : humanizeText) as typeof humanizeText;
      const res = await run(rwResult.blocks[i].original, { complete: makeComplete() });
      const fresh = res.blocks.find((b: any) => b.kind === "para") || res.blocks[0];
      setRwResult((prev: any) => {
        const blocks = [...prev.blocks];
        blocks[i] = { ...blocks[i], output: fresh.output, status: fresh.status };
        return { ...prev, blocks };
      });
      setRwAccepted((prev) => {
        const next = [...prev];
        next[i] = fresh.status.startsWith("rewritten") || fresh.status === "proofread";
        return next;
      });
    } catch (e: any) {
      setRwError(e?.message || String(e));
    }
    setRwBusy(false);
  };

  const applyRewrites = () => {
    if (!rwResult) return;
    const composed = rwResult.blocks.map((b: any, i: number) => (rwAccepted[i] ? b.output : b.original)).join("\n\n");
    setText(composed);
    setReport(null);
    setRwResult(null);
    setRwAccepted([]);
  };

  const composedOutput = rwResult
    ? rwResult.blocks.map((b: any, i: number) => (rwAccepted[i] ? b.output : b.original)).join("\n\n")
    : "";

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(composedOutput);
      setRwCopied(true);
      setTimeout(() => setRwCopied(false), 2000);
    } catch {
      setRwError("Copy was blocked by the browser - select the output text and copy it manually.");
    }
  };

  const rwCvBefore = rwResult ? styleIndicators(text).sentenceLength?.cv : null;
  const rwCvAfter = rwResult ? styleIndicators(composedOutput).sentenceLength?.cv : null;

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
            feedback on readability and citations. Every check runs in your browser and nothing is uploaded; the one exception is the optional rewrite tool below, which
            sends your draft to the AI provider you configure, using your own key.
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
              <label className="target" title="Set an essay word count goal">
                <span className="muted small">Target words</span>
                <input
                  type="number"
                  min={0}
                  step={100}
                  placeholder="2000"
                  value={target || ""}
                  onChange={(e) => setTargetWords(e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))}
                  aria-label="Target word count"
                />
              </label>
              <button type="button" className="btn-ghost" onClick={() => paperFile.current?.click()} disabled={busy}>
                Upload .txt / .md / .pdf / .docx
              </button>
              <input ref={paperFile} type="file" hidden accept=".txt,.md,.markdown,.pdf,.docx" onChange={(e) => e.target.files?.[0] && void readPaper(e.target.files[0])} />
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

          {(target > 0 || text) && (
            <div className="editor-foot">
              {target > 0 && (
                <div className="progress" role="progressbar" aria-label="Word target progress" aria-valuenow={Math.min(100, Math.round((words / target) * 100))} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${Math.min(100, (words / target) * 100)}%` }} />
                </div>
              )}
              {target > 0 && (
                <span className="muted small tabular">
                  {words} / {target} words {words > target ? "— over target" : words / target > 0.9 ? "— nearly there" : ""}
                </span>
              )}
              {text && (
                <span className="muted small">
                  Draft saved in this browser
                  <button type="button" className="btn-link" onClick={() => { clearDraft(); setText(""); }}>
                    clear
                  </button>
                </span>
              )}
            </div>
          )}
          <div className="rw-controls key-row">
            <label className="rw-field">
              <span className="muted small">IFM API key — needed for the rewrite and proofread (stored only in this browser)</span>
              <input
                type="password"
                autoComplete="off"
                placeholder="IFM-v1_…"
                value={ifmKey}
                onChange={(e) => { setIfmKey(e.target.value); saveJSON("pl.ifmKey", e.target.value); }}
                aria-label="IFM API key"
              />
            </label>
            <label className="rw-field">
              <span className="muted small">Model</span>
              <input
                type="text"
                value={ifmModel}
                onChange={(e) => { setIfmModel(e.target.value); saveJSON("pl.ifmModel", e.target.value); }}
                aria-label="IFM model"
              />
            </label>
          </div>

          <details className="refs key-help">
            <summary>
              How to get an IFM API key <span className="muted">(only the rewrite and proofread need one — every check above runs without it)</span>
            </summary>
            <div className="refs-body">
              <ol className="key-steps">
                <li>
                  Go to the IFM Platform API keys page —{" "}
                  <a href="https://platform.ifm.ai/api-keys" target="_blank" rel="noreferrer">
                    platform.ifm.ai/api-keys
                  </a>{" "}
                  — and sign in. If you don't have an IFM account yet, create one there first.
                </li>
                <li>
                  Create a new API key and copy it straight away — it starts with <code>IFM-v1_</code> and the platform shows the full key only once, so store it
                  somewhere safe.
                </li>
                <li>
                  Paste the key into the <strong>IFM API key</strong> field above. The default model (<code>IFM/K2-Horizon-375B-A23B</code>) is already filled
                  in — that's all the setup the rewrite and proofread need.
                </li>
              </ol>
              <p className="muted small">
                Your key is stored only in this browser (localStorage) and is sent only to api.ifm.ai together with the text you choose to rewrite. Nothing else
                in PaperLens ever sees it. Full official guide:{" "}
                <a href="https://docs.ifm.ai/docs/quickstart.md" target="_blank" rel="noreferrer">
                  IFM Quickstart
                </a>
                .
              </p>
            </div>
          </details>

          <div className="run-row">
            <button type="button" className="btn-primary btn-lg" onClick={runAll} disabled={!text.trim() || busy || rwBusy}>
              {busy ? "Reading file…" : rwBusy ? (rwMode === "proofread" ? "Proofreading…" : "Checking & rewriting…") : "Analyze & Rewrite"}
            </button>
            <button type="button" className="btn-ghost btn-lg" onClick={startProofread} disabled={!text.trim() || busy || rwBusy}>
              Proofread
            </button>
            {ranAt && report && <span className="muted small hint-line">Checked locally {new Date(ranAt).toLocaleTimeString()}</span>}
            {!ifmKey.trim() && <span className="muted small hint-line">No key? The checks still run — add an IFM key above to also rewrite or proofread.</span>}
          </div>
          <p className="muted small method-note">
            How the rewrite works: your text is split into paragraphs; numbers, dates and citations are locked so they cannot change; each paragraph is rewritten
            four times, the versions are checked mechanically (facts, number counts, length, and depth — near-verbatim trims are rejected), the deepest faithful
            version wins a judge round, and a final drift check can still reject it — anything that fails comes back unchanged.
          </p>
          <p className="muted small method-note">
            Proofread is the cautious opposite: it fixes grammar, spelling and punctuation only. A correction is applied only when mechanical checks confirm
            every number and citation is untouched, the length barely moved, at least 85% of the original wording is still there, and a meaning check passes —
            otherwise the paragraph comes back unchanged.
          </p>
          {rwConfirm && rwEstimate && (
            <div className="confirm-row">
              <p className="muted small">
                This is a long document: about {rwEstimate.paragraphs} paragraphs ≈ {rwEstimate.approxCalls}+ model calls against your IFM quota, and it can
                take several minutes.
              </p>
              <div className="hz-input-actions">
                <button type="button" className="btn-primary" onClick={() => { setRwConfirm(false); void runTransform(rwPendingMode); }}>
                  {rwPendingMode === "proofread" ? "Proofread anyway" : "Rewrite anyway"}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setRwConfirm(false)}>
                  {rwPendingMode === "proofread" ? "Skip the proofread" : "Skip the rewrite"}
                </button>
              </div>
            </div>
          )}
          {fileNote && <p className={`file-note ${/Could not|no text|scan|not supported|zip/i.test(fileNote) ? "bad" : ""}`} role="status">{fileNote}</p>}
        </section>

        <section className="citcheck card" aria-labelledby="citcheck-title" ref={citSection}>
          <div className="hz-panel-head">
            <span id="citcheck-title" className="hz-panel-title">Citation check</span>
          </div>
          <p className="muted">
            Checks the citations and the reference list <strong>inside your paper itself</strong> — every entry field by field (authors, year, title,
            venue, DOI), plus a cross-check that everything cited in the text appears in the list and everything listed is cited. It needs nothing
            else: no references to upload, no IFM key.
          </p>
          <div className="run-row">
            <button type="button" className="btn-primary" onClick={runCitationCheck} disabled={!text.trim() || busy}>
              Check citations
            </button>
            {!text.trim() && <span className="muted small">Paste or upload your paper above first.</span>}
            {citText != null && citText !== text && <span className="muted small">Your paper changed since this check — run it again to refresh the results.</span>}
          </div>
          {citText != null && <Citations text={citText} />}
        </section>

        {(rwBusy || rwResult || rwError) && (
          <section className="rewrite card" aria-labelledby="rw-out-label">
            <div className="hz-panel-head">
              <span id="rw-out-label" className="hz-panel-title">{rwMode === "proofread" ? "✦ Proofread — errors fixed, wording kept" : "✦ Rewritten in a natural voice"}</span>
              <a className="btn-link" href="https://github.com/rajeevranjanpandey/paperlens#rewrite-with-ifm-optional" target="_blank" rel="noreferrer">
                How it works
              </a>
            </div>
            {rwBusy && (
              <div className="rw-progress">
                <div className="progress">
                  <div
                    className="bar"
                    style={{ width: `${rwProgress ? Math.round((rwProgress.done / Math.max(rwProgress.total, 1)) * 100) : 0}%` }}
                  />
                </div>
                <div className="hz-panel-foot">
                  <span className="muted small">
                    {rwProgress
                      ? `${rwMode === "proofread" ? "Proofreading" : "Rewriting"}… block ${rwProgress.done} of ${rwProgress.total}`
                      : rwMode === "proofread"
                        ? "Proofreading…"
                        : "Rewriting…"}
                  </span>
                  <button type="button" className="btn-ghost" onClick={() => rwAbort.current?.abort()}>
                    {rwMode === "proofread" ? "Cancel proofread" : "Cancel rewrite"}
                  </button>
                </div>
              </div>
            )}
            {rwError && <p className="file-note bad" role="alert">{rwError}</p>}
            {rwResult && (
              <>
                <p className="muted small">
                  {rwResult.stats.wordsIn} words in → {rwResult.stats.wordsOut} out ·{" "}
                  {rwMode === "proofread" ? rwResult.stats.proofread : rwResult.stats.rewritten} {rwMode === "proofread" ? "proofread" : "rewritten"},{" "}
                  {rwResult.stats.kept} kept
                  {rwCvBefore != null && rwCvAfter != null ? ` · sentence-length variation ${rwCvBefore.toFixed(2)} → ${rwCvAfter.toFixed(2)}` : ""}
                </p>
                {rwResult.stats.cancelled && (
                  <p className="file-note">{rwMode === "proofread" ? "Proofreading" : "Rewrite"} cancelled partway — blocks that were not run kept their original text, marked “not run (cancelled)” below.</p>
                )}
                <div className="hz-out-text">{composedOutput}</div>
                <div className="hz-panel-foot">
                  <button type="button" className="btn-ghost" onClick={() => void copyOutput()}>
                    {rwCopied ? "Copied ✓" : "Copy output"}
                  </button>
                  <div className="hz-input-actions">
                    <button type="button" className="btn-ghost" onClick={() => { setRwResult(null); setRwAccepted([]); }}>
                      Discard
                    </button>
                    <button type="button" className="btn-primary" onClick={applyRewrites} disabled={rwBusy}>
                      Apply to paper
                    </button>
                  </div>
                </div>

                <h4 className="sub">Paragraph by paragraph</h4>
                {rwResult.blocks.some((b: any) => b.kind === "para") && (
                  <p className="muted small">
                    {rwResult.blocks.filter((b: any) => b.kind === "para" && (b.status.startsWith("rewritten") || b.status === "proofread")).length} of{" "}
                    {rwResult.blocks.filter((b: any) => b.kind === "para").length} paragraphs {rwMode === "proofread" ? "proofread" : "rewritten"}
                  </p>
                )}
                <p className="rw-legend muted small">
                  <span className="hl hl-changed" aria-hidden="true" />
                  Green highlights = wording that changed
                </p>
                <div className="rw-results">
                  {rwResult.blocks.map((b: any, i: number) => (
                    <div key={i} className="rw-block">
                      <div className="rw-cols">
                        <div className="rw-col">
                          <span className="stat-label">Original · {b.kind}</span>
                          <p>{b.original}</p>
                        </div>
                        <div className="rw-col out">
                          <span className="stat-label">
                            Output
                            {b.status.startsWith("rewritten") || b.status === "proofread"
                              ? ` · ${Math.round(changedRatio(b.original, b.output) * 100)}% of words changed`
                              : ""}
                          </span>
                          <p>
                            {b.status.startsWith("rewritten") || b.status === "proofread" ? (
                              <HighlightedText original={b.original} output={b.output} />
                            ) : (
                              b.output
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="rw-actions">
                        <span className={pillClass(b.status)}>{b.status}</span>
                        {b.output !== b.original && (
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={!!rwAccepted[i]}
                              onChange={(e) => setRwAccepted((prev) => { const next = [...prev]; next[i] = e.target.checked; return next; })}
                            />
                            {rwMode === "proofread" ? "Use this correction" : "Use this rewrite"}
                          </label>
                        )}
                        {b.kind === "para" && (
                          <button type="button" className="btn-ghost" onClick={() => void redoBlock(i)} disabled={rwBusy}>
                            Redo paragraph
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {report && (
          <section className="report" aria-label="Report">
            <div className="report-actions">
              <button type="button" className="btn-ghost" onClick={() => downloadReport(report!)}>
                Download report
              </button>
              <span className="muted small">Reports are generated in your browser and never leave it.</span>
            </div>
            <nav className="tabs" role="tablist" aria-label="Report sections">
              {([
                ["overview", "Overview"],
                ["repetition", "Repetition"],
                ["style", "Writing style"],
                ["quality", "Quality"],
                ["citations", "Citations"],
              ] as const).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </nav>

            {tab === "overview" && <Overview r={report} text={text} />}
            {tab === "repetition" && <Repetition r={report.similarity} text={text} />}
            {tab === "style" && <Style r={report.style} />}
            {tab === "quality" && <Quality r={report.quality} full={report} text={text} />}
            {tab === "citations" && <Citations text={text} />}
          </section>
        )}

        {history.length > 0 && (
          <section className="history" aria-labelledby="hist-title">
            <h3 id="hist-title">Recent checks</h3>
            <p className="muted small">Stored only in this browser. Word count and repeated text at the moment of each check.</p>
            <ul>
              {history.map((h) => (
                <li key={h.at}>
                  <span className="tabular">{new Date(h.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="tabular">{h.words} words</span>
                  <span className={`tabular sim ${(h.repetition ?? 0) >= 25 ? "bad" : (h.repetition ?? 0) >= 10 ? "warn" : "good"}`}>{h.repetition ?? 0}% repeated</span>
                  <span className="tabular">{h.flags} flags</span>
                </li>
              ))}
            </ul>
            <button type="button" className="btn-link" onClick={() => { setHistory([]); saveJSON("pl.history", []); }}>
              clear history
            </button>
          </section>
        )}
      </main>

      <footer className="foot">
        <span>PaperLens · checks run entirely in your browser</span>
        <span className="muted">
          Not affiliated with Turnitin. The repetition check compares your paper only against itself; style indicators are experimental statistics, not authorship verdicts.
        </span>
      </footer>
    </div>
  );
}

/* ---------------- Overview ---------------- */

function Overview({ r, text }: { r: ReturnType<typeof analyze>; text: string }) {
  const { similarity, style, quality } = r;
  const rep = similarity.selfRepetition;
  const tone = rep.percent >= 25 ? "bad" : rep.percent >= 10 ? "warn" : "good";
  const cit = citationCheck(text);
  return (
    <div className="cards">
      <div className={`card stat ${tone}`}>
        <span className="stat-label">Repetition</span>
        <strong className="big tabular">{fmtPct(rep.percent)}</strong>
        <span className="muted">
          {rep.percent === 0
            ? "No passages repeat inside this paper."
            : "Text that repeats inside the paper itself — doubled phrases and recycled passages. No references are used; the paper is checked against itself."}
        </span>
        <span className="flag">Detail in the Repetition tab</span>
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
      <div className={`card stat ${cit.summary.flagged || cit.summary.missingInText ? "warn" : ""}`}>
        <span className="stat-label">Citation check</span>
        <strong className="big tabular">{cit.hasReferenceSection ? cit.summary.entries : "–"}</strong>
        <span className="muted">
          {cit.hasReferenceSection
            ? `${cit.summary.withDoi} with a DOI · ${cit.summary.flagged} to verify · ${cit.summary.missingInText} cited but missing · ${cit.summary.uncited} never cited.`
            : "No reference list found under a References heading."}
        </span>
        <span className="flag">Field-by-field detail in the Citations tab</span>
      </div>
      <div className="card wide">
        <h3>What to do next</h3>
        <ul className="next">
          <li>
            Open <strong>Repetition</strong> to see passages that repeat inside the paper itself and trim the accidental doubles.
          </li>
          <li>
            Open <strong>Writing style</strong> for statistics that reviewers and editors associate with polished prose, including uniformity of sentence length.
          </li>
          <li>
            Open <strong>Quality</strong> for readability scores, passive-voice density, citation detection and specific suggestions for this draft.
          </li>
          <li>
            Open <strong>Citations</strong> to check every reference field by field — DOI, year, duplicates, ordering — with one-click verification links.
          </li>
        </ul>
        <p className="muted small">{text.trim().split(/\s+/).length} words analyzed locally.</p>
      </div>
    </div>
  );
}

/* ---------------- Repetition ---------------- */

function Repetition({ r, text }: { r: ReturnType<typeof analyze>["similarity"]; text: string }) {
  const rep = r.selfRepetition;
  const marks = [...rep.runs].sort((a, b) => a.start - b.start);
  const segments: { text: string; repeated?: boolean }[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start < cursor) continue; // overlaps: first match wins
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start) });
    segments.push({ text: text.slice(m.start, m.end), repeated: true });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>Repetition within this paper: {fmtPct(rep.percent)}</h3>
          <p className="muted">
            Passages that repeat inside the paper itself, word for word — doubled phrases, recycled sentences, copy-paste slips. No references
            are used and nothing is compared against external sources: the paper is checked against itself only.
          </p>
        </div>
      </div>

      {rep.percent === 0 && <p className="empty">No repeated passages were found.</p>}

      {rep.runs.length > 0 && (
        <>
          <h4 className="sub">Your paper, highlighted</h4>
          <div className="marked">
            {segments.map((s, i) =>
              s.repeated ? (
                <mark key={i} style={{ background: "#d9d9d9", borderBottom: "2px solid #999" }}>
                  {s.text}
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </div>

          <h4 className="sub">Repeated passages</h4>
          <ul className="matches">
            {rep.runs.map((run, i) => {
              const excerpt = text.slice(run.start, run.end);
              return (
                <li key={i}>
                  <i className="dot" style={{ background: "#999" }} />
                  <div>
                    <p className="quote">“{excerpt.slice(0, 220)}{excerpt.length > 220 ? "…" : ""}”</p>
                    <p className="muted small">12-word span · repeats inside this paper</p>
                  </div>
                </li>
              );
            })}
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

/* ---------------- Citations ---------------- */

function Citations({ text }: { text: string }) {
  const r = useMemo(() => citationCheck(text), [text]);
  const [vf, setVf] = useState<{ running: boolean; done: number; results: any[] | null }>({ running: false, done: 0, results: null });
  useEffect(() => {
    setVf({ running: false, done: 0, results: null });
  }, [text]);
  const vfByIndex = useMemo(() => {
    const m = new Map<number, any>();
    (vf.results || []).forEach((x: any) => m.set(x.index, x));
    return m;
  }, [vf.results]);
  const vfCounts = useMemo(() => {
    const c = { verified: 0, mismatch: 0, notFound: 0, error: 0 };
    (vf.results || []).forEach((x: any) => {
      if (x.status === "verified") c.verified++;
      else if (x.status === "mismatch") c.mismatch++;
      else if (x.status === "not-found") c.notFound++;
      else c.error++;
    });
    return c;
  }, [vf.results]);
  const runVerify = async () => {
    setVf({ running: true, done: 0, results: null });
    try {
      const results = await verifyReferences(r.entries, {
        onProgress: (d: number) => setVf((p) => ({ ...p, done: d })),
      });
      setVf({ running: false, done: results.length, results });
    } catch {
      setVf({ running: false, done: 0, results: null });
    }
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>Citation check</h3>
          <p className="muted">
            Each reference is split into fields — authors, year, title, venue, DOI — and every field is checked separately, because a citation can point at a real
            paper and still be wrong. The field checks below run locally and judge format and plausibility only. For the question they cannot answer — does this
            source actually exist, with these authors and this year? — run the online verification: it looks each entry up in Crossref and OpenAlex, the free
            catalogs behind most DOI records.
          </p>
        </div>
      </div>

      {!r.hasReferenceSection ? (
        <p className="empty">
          No reference list was found. Add one under a “References” or “Bibliography” heading and this check will check every entry field by field, and cross-check it
          against the citations in your text.
        </p>
      ) : (
        <>
          <div className="cards">
            <div className="card stat">
              <span className="stat-label">Reference entries</span>
              <strong className="big tabular">{r.summary.entries}</strong>
              <span className="muted small">{r.styles.length ? `In-text styles detected: ${r.styles.join(", ")}` : "No in-text citations detected"}</span>
            </div>
            <div className="card stat">
              <span className="stat-label">Entries with a DOI</span>
              <strong className="big tabular">{r.summary.withDoi}</strong>
              <span className="muted small">DOI syntax is checked locally; resolving it is one click on the entry below.</span>
            </div>
            <div className={`card stat ${r.summary.flagged ? "warn" : ""}`}>
              <span className="stat-label">Entries to verify</span>
              <strong className="big tabular">{r.summary.flagged}</strong>
              <span className="muted small">Entries carrying at least one warning-level signal.</span>
            </div>
            <div className={`card stat ${r.summary.missingInText || r.summary.uncited ? "warn" : ""}`}>
              <span className="stat-label">Cross-check</span>
              <strong className="big tabular">{r.summary.missingInText + r.summary.uncited}</strong>
              <span className="muted small">
                {r.summary.missingInText} cited in text with no entry · {r.summary.uncited} listed but never cited
                {r.ieeeMissing.length ? ` · IEEE numbers with no entry: ${r.ieeeMissing.join(", ")}` : ""}
              </span>
            </div>
          </div>

          <div className="run-row">
            <button type="button" className="btn-primary" onClick={runVerify} disabled={vf.running}>
              {vf.running ? `Verifying… ${vf.done}/${r.entries.length}` : "Verify references online"}
            </button>
            <span className="hint-line muted small">
              Opt-in and free: sends only these reference entries — never your paper's text — to Crossref and OpenAlex to confirm each source exists and its
              title, authors and year match.
            </span>
          </div>
          {vf.results && (
            <p className="note">
              Online verification: <strong>{vfCounts.verified} verified</strong> · {vfCounts.mismatch} to check · {vfCounts.notFound} not found
              {vfCounts.error ? ` · ${vfCounts.error} couldn't be checked (connection problem)` : ""}. Details are on each entry below.
            </p>
          )}

          {r.missing.length > 0 && (
            <>
              <h4 className="sub">Cited in the text, missing from the list</h4>
              <ul className="flaglist">
                {r.missing.map((m: any, i: number) => (
                  <li key={i}>
                    <code>{m.raw}</code>
                    <span className="muted">{m.surname}, {m.year} — no matching reference entry</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4 className="sub">Every entry, field by field</h4>
          <ul className="cit-list">
            {r.entries.map((e: any) => {
              const v = vfByIndex.get(e.index);
              return (
              <li key={e.index} className="cit-entry">
                <p className="cit-line">{e.line}</p>
                <div className="cit-fields">
                  <span className="pill">{e.num ? `IEEE [${e.num}]` : e.surname || "entry"}</span>
                  {v && (
                    <span
                      className={`pill ${v.status === "verified" ? "pill-ok" : v.status === "not-found" ? "pill-bad" : v.status === "mismatch" ? "pill-warn" : ""}`}
                    >
                      {v.status === "verified"
                        ? `Verified · ${v.source}`
                        : v.status === "mismatch"
                          ? "Check details"
                          : v.status === "not-found"
                            ? "Not found online"
                            : "Couldn't check"}
                    </span>
                  )}
                  {e.year && <span className="pill">{e.year}</span>}
                  {e.doi ? (
                    <a className="cit-link" href={e.doiUrl} target="_blank" rel="noreferrer">
                      DOI: {e.doi}
                    </a>
                  ) : (
                    <span className="muted small">no DOI</span>
                  )}
                  <a className="cit-link" href={e.scholarUrl} target="_blank" rel="noreferrer">
                    Verify on Google Scholar
                  </a>
                </div>
                {e.flags.length > 0 && (
                  <ul className="flaglist">
                    {e.flags.map((f: any, i: number) => (
                      <li key={i}>
                        <span className={`pill ${f.level === "warn" ? "pill-warn" : ""}`}>{f.level === "warn" ? "check" : "note"}</span>
                        <span className="muted">{f.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {v && v.status !== "verified" && (
                  <ul className="flaglist">
                    {v.diffs.map((d: string, i: number) => (
                      <li key={i}>
                        <span className={`pill ${v.status === "not-found" ? "pill-bad" : "pill-warn"}`}>online</span>
                        <span className="muted">{d}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {v && v.record && v.status !== "verified" && (
                  <p className="muted small">
                    Closest record ({v.source}): “{v.record.title}”
                    {v.record.year ? ` (${v.record.year})` : ""}
                    {v.record.url ? (
                      <>
                        {" — "}
                        <a className="cit-link" href={v.record.url} target="_blank" rel="noreferrer">
                          open record
                        </a>
                      </>
                    ) : null}
                  </p>
                )}
              </li>
              );
            })}
          </ul>
          <p className="note">
            Why field-by-field? Studies of AI-generated bibliographies have found large shares of fabricated or mangled references, and a reference can be wrong in
            one field — wrong year, wrong authors, invented DOI — while looking right overall. A warning here means “verify this field”, never “this source is
            fake”.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------- Quality ---------------- */

function Quality({ r, full, text }: { r: ReturnType<typeof analyze>["quality"]; full: ReturnType<typeof analyze>; text: string }) {
  const read = r.readability;
  const cross = full.citations;
  const tone = full.tone;
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

      {cross.hasReferenceSection ? (
        <>
          <h4 className="sub">Citations vs reference list</h4>
          {cross.missing.length === 0 && cross.uncited.length === 0 ? (
            <p className="note">Every in-text citation has a matching reference entry, and every entry is cited.</p>
          ) : (
            <div className="cards">
              {cross.missing.length > 0 && (
                <div className="card stat">
                  <span className="stat-label">Cited but not in the list</span>
                  <strong className="big tabular">{cross.missing.length}</strong>
                  <ul className="flaglist">
                    {cross.missing.map((c, i) => (
                      <li key={i}>
                        <code>{c.raw}</code> — {c.surname}, {c.year}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cross.uncited.length > 0 && (
                <div className="card stat">
                  <span className="stat-label">Listed but never cited</span>
                  <strong className="big tabular">{cross.uncited.length}</strong>
                  <ul className="flaglist">
                    {cross.uncited.map((e: { line: string }, i: number) => (
                      <li key={i}>
                        <code>{e.line.slice(0, 60)}…</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cross.ieee && cross.ieee.entryCount > 0 && cross.ieee.missing.length > 0 && (
                <div className="card stat">
                  <span className="stat-label">Numbers without entries</span>
                  <strong className="big tabular">{cross.ieee.missing.length}</strong>
                  <span className="muted small">In-text [{cross.ieee!.missing.join(", ")}] have no matching numbered entry.</span>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="note">
          No reference list was found. Add one with a “References” or “Bibliography” heading to enable citation cross-checking.
        </p>
      )}

      <h4 className="sub">Academic tone</h4>
      {tone.length === 0 ? (
        <p className="note">No informal wording, second-person address or stray exclamation marks were found.</p>
      ) : (
        <ul className="flaglist tone-list">
          {tone.slice(0, 12).map((f, i) => (
            <li key={i}>
              <code>“{f.text}”</code>
              <span className="muted">{f.note}</span>
            </li>
          ))}
          {tone.length > 12 && <li className="muted small">…and {tone.length - 12} more.</li>}
        </ul>
      )}

      {(tone.length > 0 || (full.style.phraseSpans?.length ?? 0) > 0) && (
        <>
          <h4 className="sub">Flagged in your text</h4>
          <p className="hl-legend">
            <span><i className="hl hl-tone" /> informal / tone</span>
            <span><i className="hl hl-phrase" /> recycled phrase</span>
          </p>
          <div className="marked hl-view">{renderFlagged(text, tone, full.style.phraseSpans || [])}</div>
        </>
      )}
    </div>
  );
}

/** Paper text with tone and phrase flags highlighted inline. */
function renderFlagged(text: string, tone: { start: number; end: number }[], phrases: { start: number; end: number }[]) {
  const spans = [
    ...tone.map((f) => ({ ...f, kind: "tone" as const })),
    ...phrases.map((f) => ({ ...f, kind: "phrase" as const })),
  ].sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const sp of spans) {
    if (sp.start < cursor) continue; // overlap: first flag wins
    if (sp.start > cursor) out.push(<span key={key++}>{text.slice(cursor, sp.start)}</span>);
    out.push(
      <mark key={key++} className={sp.kind === "tone" ? "hl-tone" : "hl-phrase"}>
        {text.slice(sp.start, sp.end)}
      </mark>,
    );
    cursor = sp.end;
  }
  if (cursor < text.length) out.push(<span key={key++}>{text.slice(cursor)}</span>);
  return out;
}

/** Build a plain-text report and download it. Nothing leaves the browser. */
function downloadReport(report: ReturnType<typeof analyze>) {
  const L: string[] = [];
  const { similarity, style, quality, citations, tone } = report;
  L.push("PaperLens report");
  L.push(`Generated ${new Date().toLocaleString()}`);
  L.push("");
  L.push("REPETITION (within this paper)");
  L.push(`  ${similarity.selfRepetition.percent.toFixed(1)}% of the paper repeats inside itself (${similarity.selfRepetition.runs.length} repeated passage(s))`);
  L.push("");
  L.push("WRITING STYLE (experimental, descriptive only)");
  if (style.sentenceLength) L.push(`  Sentence length: mean ${style.sentenceLength.mean.toFixed(0)} words, variation ${style.sentenceLength.cv.toFixed(2)}`);
  L.push(`  Vocabulary variety (type-token ratio): ${style.typeTokenRatio?.toFixed(2) ?? "–"}`);
  L.push(`  Common phrases: ${style.commonPhrases.length ? style.commonPhrases.join(", ") : "none"}`);
  L.push("");
  L.push("QUALITY");
  L.push(`  ${quality.wordCount} words, ${quality.sentenceCount} sentences, ${quality.paragraphCount} paragraphs`);
  if (quality.readability.enough) {
    L.push(`  Flesch reading ease ${quality.readability.fleschReadingEase}, grade level ${quality.readability.fleschKincaidGrade}`);
  }
  L.push(`  Long sentences (>35 words): ${quality.longSentences}; passive constructions: ${quality.passiveCount}`);
  L.push(`  Citations detected: ${quality.citations.length}`);
  if (citations.hasReferenceSection) {
    L.push(`  Cited but missing from the reference list: ${citations.missing.map((c) => c.raw).join("; ") || "none"}`);
    L.push(`  Listed but never cited: ${citations.uncited.map((e: { line: string }) => e.line.slice(0, 50)).join("; ") || "none"}`);
  } else {
    L.push("  No reference list found; citation cross-check skipped");
  }
  L.push("");
  L.push("ACADEMIC TONE");
  L.push(tone.length ? tone.map((f) => `  - "${f.text}": ${f.note}`).join("\n") : "  No informal wording found.");
  L.push("");
  if (quality.suggestions.length) {
    L.push("SUGGESTIONS");
    for (const s of quality.suggestions) L.push(`  - ${s}`);
    L.push("");
  }
  L.push("The repetition check compares the paper only against itself. Style indicators are");
  L.push("experimental statistics, not authorship verdicts. Generated locally by PaperLens.");
  const blob = new Blob([L.join("\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "paperlens-report.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
