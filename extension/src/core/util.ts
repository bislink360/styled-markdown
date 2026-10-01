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

const PRIORITY_RANK: Record<string, number> = { p0: 0, critical: 0, p1: 1, high: 1, p2: 2, medium: 2, p3: 3, low: 3, p4: 4 };

/** Sort rank of a task priority: P0/critical first, no priority last. */
export function priorityRank(priority?: string): number {
  return PRIORITY_RANK[(priority ?? '').toLowerCase()] ?? 5;
}
