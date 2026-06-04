// Fuzzy command palette search. Replaces Boop's Fuse dependency with a tiny
// subsequence scorer — enough for a few dozen entries, zero deps. Generic over
// the item type so it can rank scripts and actions in one list.

/**
 * Subsequence fuzzy score: every query char must appear in order. Consecutive
 * and word-start matches score higher. Returns -1 for no match.
 */
function fuzzyScore(query: string, target: string): number {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const found = t.indexOf(c, ti);
    if (found === -1) return -1;
    if (found === prevMatch + 1) score += 3; // consecutive
    if (found === 0 || /[\s\-_]/.test(t[found - 1])) score += 2; // word start
    score += 1;
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer shorter targets (tighter matches).
  return score - target.length * 0.01;
}

/**
 * Ranks items by fuzzy match against `textOf(item)`. An empty query returns
 * the items unchanged (preserving the caller's ordering).
 */
export function search<T>(items: T[], query: string, textOf: (item: T) => string): T[] {
  if (query === "") return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, textOf(item));
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
