/** Closest known word within a small edit distance, for "did you mean" hints. */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Math.max(2, Math.floor(word.length / 3)) + 1;
  for (const c of candidates) {
    const d = levenshtein(word.toLowerCase(), c.toLowerCase());
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
