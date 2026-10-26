// Word-level diff between an original paragraph and its rewrite.
//
// wordDiff(original, rewritten) returns one token per word of the
// REWRITTEN text: { text, changed }. A rewritten word counts as
// unchanged when it survives from the original in the same relative
// order (longest common subsequence over words); every other word —
// swapped, reworded or newly inserted — is flagged changed. Joining
// the token texts with single spaces reproduces the rewritten text
// with normalised spacing.
//
// Comparison ignores case and edge punctuation, so "results." vs
// "results" (or a moved comma) does not light up as a change; the
// token text kept for display is always the rewritten word verbatim.
// Paragraphs here are at most ~250 words, so the O(n*m) LCS table is
// trivially cheap.

// Strip case and leading/trailing punctuation for comparison only.
function normalise(word) {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}%]+/u, "")
    .replace(/[^\p{L}\p{N}%]+$/u, "");
}

function splitWords(text) {
  return String(text ?? "").split(/\s+/).filter(Boolean);
}

export function wordDiff(original, rewritten) {
  const a = splitWords(original).map(normalise);
  const bWords = splitWords(rewritten);
  const b = bWords.map(normalise);
  const n = a.length;
  const m = bWords.length;
  if (m === 0) return [];

  // LCS length table.
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack: rewritten words reached diagonally are unchanged.
  const unchanged = new Array(m).fill(false);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      unchanged[j - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--; // original word dropped or moved
    } else {
      j--; // rewritten word inserted or substituted
    }
  }

  return bWords.map((text, k) => ({ text, changed: !unchanged[k] }));
}

// Fraction of the rewritten text's words that changed (0..1).
export function changedRatio(original, rewritten) {
  const tokens = wordDiff(original, rewritten);
  if (!tokens.length) return 0;
  return tokens.filter((t) => t.changed).length / tokens.length;
}
