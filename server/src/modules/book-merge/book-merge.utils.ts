export type MergeReadingAttempt = {
  id: number;
  user_id: number;
  book_id: number;
  outcome: string | null;
  deleted_at: Date | null;
  external_provider: string | null;
  external_id: string | null;
};

/**
 * Resolve duplicate reading attempts to a single survivor before changing their book IDs.
 *
 * Active attempts are unique per user/book, while imported attempts can also be unique by
 * user/provider/external ID. Those two duplicate rules can overlap, so they must be reconciled
 * as connected groups rather than as independent pairwise matches.
 */
export function buildReadingAttemptSurvivors(attempts: readonly MergeReadingAttempt[], targetBookId: number): Map<number, number> {
  const parent = new Map(attempts.map((attempt) => [attempt.id, attempt.id]));

  const find = (id: number): number => {
    const current = parent.get(id);
    if (current === undefined) return id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };

  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  const activeByUser = new Map<number, number[]>();
  const externalByIdentity = new Map<string, number[]>();
  for (const attempt of attempts) {
    if (attempt.outcome === null && attempt.deleted_at === null) {
      const group = activeByUser.get(attempt.user_id) ?? [];
      group.push(attempt.id);
      activeByUser.set(attempt.user_id, group);
    }
    if (attempt.external_provider !== null && attempt.external_id !== null) {
      const key = JSON.stringify([attempt.user_id, attempt.external_provider, attempt.external_id]);
      const group = externalByIdentity.get(key) ?? [];
      group.push(attempt.id);
      externalByIdentity.set(key, group);
    }
  }

  for (const group of [...activeByUser.values(), ...externalByIdentity.values()]) {
    for (let index = 1; index < group.length; index += 1) union(group[0]!, group[index]!);
  }

  const components = new Map<number, MergeReadingAttempt[]>();
  for (const attempt of attempts) {
    const root = find(attempt.id);
    const group = components.get(root) ?? [];
    group.push(attempt);
    components.set(root, group);
  }

  const survivors = new Map<number, number>();
  for (const group of components.values()) {
    if (group.length < 2) continue;
    const survivor = group.find((attempt) => attempt.book_id === targetBookId) ?? group.reduce((lowest, attempt) => attempt.id < lowest.id ? attempt : lowest);
    for (const attempt of group) {
      if (attempt.id !== survivor.id) survivors.set(attempt.id, survivor.id);
    }
  }
  return survivors;
}
