import { describe, expect, it } from 'vitest';

import { buildReadingAttemptSurvivors, type MergeReadingAttempt } from './book-merge.utils';

function attempt(overrides: Partial<MergeReadingAttempt> & Pick<MergeReadingAttempt, 'id' | 'book_id'>): MergeReadingAttempt {
  return {
    user_id: 1,
    outcome: null,
    deleted_at: null,
    external_provider: null,
    external_id: null,
    ...overrides,
  };
}

describe('buildReadingAttemptSurvivors', () => {
  it('maps duplicate external identities directly to the target-book attempt', () => {
    const attempts = [
      attempt({ id: 10, book_id: 100, external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 20, book_id: 200, external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 30, book_id: 300, external_provider: 'hardcover', external_id: 'abc' }),
    ];

    expect(buildReadingAttemptSurvivors(attempts, 200)).toEqual(new Map([[10, 20], [30, 20]]));
  });

  it('does not collapse distinct attempts connected through overlapping conflict rules', () => {
    const attempts = [
      attempt({ id: 10, book_id: 100, external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 20, book_id: 200, outcome: 'completed', external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 30, book_id: 300 }),
    ];

    // Attempt 10 conflicts with 20 by external identity and with 30 because both
    // are active. Attempts 20 and 30 do not conflict and must both survive.
    expect(buildReadingAttemptSurvivors(attempts, 200)).toEqual(new Map([[10, 20]]));
  });

  it('preserves a target completed attempt and a separate target active attempt', () => {
    const attempts = [
      attempt({ id: 10, book_id: 200, outcome: 'completed', external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 20, book_id: 200 }),
      attempt({ id: 30, book_id: 100, external_provider: 'hardcover', external_id: 'abc' }),
    ];

    // Source attempt 30 conflicts with target attempt 10 by external identity
    // and target attempt 20 by active status. It must not cause 10 and 20 to
    // be treated as duplicates of each other.
    expect(buildReadingAttemptSurvivors(attempts, 200)).toEqual(new Map([[30, 10]]));
  });

  it('keeps different users’ external records separate and chooses the lowest ID without a target attempt', () => {
    const attempts = [
      attempt({ id: 30, book_id: 300, user_id: 1, external_provider: 'hardcover', external_id: 'same' }),
      attempt({ id: 20, book_id: 200, user_id: 1, external_provider: 'hardcover', external_id: 'same' }),
      attempt({ id: 10, book_id: 100, user_id: 2, external_provider: 'hardcover', external_id: 'same' }),
    ];

    expect(buildReadingAttemptSurvivors(attempts, 400)).toEqual(new Map([[30, 20]]));
  });

  it('does not apply active-attempt uniqueness to soft-deleted attempts', () => {
    const attempts = [
      attempt({ id: 10, book_id: 100, deleted_at: new Date('2025-01-01T00:00:00Z') }),
      attempt({ id: 20, book_id: 200 }),
    ];

    expect(buildReadingAttemptSurvivors(attempts, 200)).toEqual(new Map());
  });

  it('still applies external identity uniqueness to soft-deleted attempts', () => {
    const attempts = [
      attempt({ id: 10, book_id: 100, deleted_at: new Date('2025-01-01T00:00:00Z'), external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 20, book_id: 200, external_provider: 'hardcover', external_id: 'abc' }),
    ];

    expect(buildReadingAttemptSurvivors(attempts, 200)).toEqual(new Map([[10, 20]]));
  });
});
