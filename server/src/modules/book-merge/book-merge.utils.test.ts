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
  it('maps every duplicate directly to the target-book attempt when external IDs overlap', () => {
    const attempts = [
      attempt({ id: 10, book_id: 100, external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 20, book_id: 200, external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 30, book_id: 300, external_provider: 'hardcover', external_id: 'abc' }),
    ];

    expect(buildReadingAttemptSurvivors(attempts, 200)).toEqual(new Map([[10, 20], [30, 20]]));
  });

  it('reconciles overlapping active-attempt and external-ID duplicate groups transitively', () => {
    const attempts = [
      attempt({ id: 10, book_id: 100, external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 20, book_id: 200, outcome: 'completed', external_provider: 'hardcover', external_id: 'abc' }),
      attempt({ id: 30, book_id: 300 }),
    ];

    expect(buildReadingAttemptSurvivors(attempts, 200)).toEqual(new Map([[10, 20], [30, 20]]));
  });

  it('keeps different users’ external records separate and chooses the lowest ID without a target attempt', () => {
    const attempts = [
      attempt({ id: 30, book_id: 300, user_id: 1, external_provider: 'hardcover', external_id: 'same' }),
      attempt({ id: 20, book_id: 200, user_id: 1, external_provider: 'hardcover', external_id: 'same' }),
      attempt({ id: 10, book_id: 100, user_id: 2, external_provider: 'hardcover', external_id: 'same' }),
    ];

    expect(buildReadingAttemptSurvivors(attempts, 400)).toEqual(new Map([[30, 20]]));
  });
});
