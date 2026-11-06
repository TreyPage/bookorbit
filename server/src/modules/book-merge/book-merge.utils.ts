export type MergeReadingAttempt = {
  id: number;
  user_id: number;
  book_id: number;
  outcome: string | null;
  deleted_at: Date | null;
  external_provider: string | null;
  external_id: string | null;
};

function conflicts(left: MergeReadingAttempt, right: MergeReadingAttempt): boolean {
  const sameUser = left.user_id === right.user_id;
  if (!sameUser) return false;

  const bothActive =
    left.outcome === null &&
    left.deleted_at === null &&
    right.outcome === null &&
    right.deleted_at === null;

  const sameExternalIdentity =
    left.external_provider !== null &&
    left.external_id !== null &&
    left.external_provider === right.external_provider &&
    left.external_id === right.external_id;

  return bothActive || sameExternalIdentity;
}

/**
 * Resolve only attempts that would violate a reading_attempts unique constraint
 * after the source books are reassigned to the target book.
 *
 * Do not collapse connected conflict groups: two attempts can each conflict with
 * a third attempt while remaining valid alongside one another. Prefer existing
 * target-book attempts, then the lowest ID, and map each discarded attempt
 * directly to one retained conflicting attempt.
 */
export function buildReadingAttemptSurvivors(
  attempts: readonly MergeReadingAttempt[],
  targetBookId: number,
): Map<number, number> {
  const ordered = [...attempts].sort((left, right) => {
    const leftIsTarget = left.book_id === targetBookId;
    const rightIsTarget = right.book_id === targetBookId;
    if (leftIsTarget !== rightIsTarget) return leftIsTarget ? -1 : 1;
    return left.id - right.id;
  });

  const retained: MergeReadingAttempt[] = [];
  const survivors = new Map<number, number>();

  for (const attempt of ordered) {
    const conflictingRetained = retained
      .filter((candidate) => conflicts(attempt, candidate))
      .sort((left, right) => {
        const leftIsTarget = left.book_id === targetBookId;
        const rightIsTarget = right.book_id === targetBookId;
        if (leftIsTarget !== rightIsTarget) return leftIsTarget ? -1 : 1;
        return left.id - right.id;
      });

    const survivor = conflictingRetained[0];
    if (survivor) {
      survivors.set(attempt.id, survivor.id);
    } else {
      retained.push(attempt);
    }
  }

  return survivors;
}
