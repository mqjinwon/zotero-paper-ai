/** Reciprocal rank fusion over ordered id lists (rank 0 = best). */
export function rrfFuse(
  rankLists: string[][],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      if (!id) return;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
