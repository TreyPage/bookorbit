import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { bookFiles } from './books';
import { users } from './auth';

export type ContentVerificationSource = 'ebook' | 'audiobook';
export type ContentVerificationStatus = 'match' | 'mismatch' | 'inconclusive' | 'error';
export type ContentVerificationReviewStatus = 'confirmed_mismatch' | 'false_positive' | 'needs_recheck';

export interface ContentVerificationEvidence {
  label: string;
  text: string;
}

export const bookContentVerifications = pgTable(
  'book_content_verifications',
  {
    id: serial('id').primaryKey(),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    fileHash: varchar('file_hash', { length: 32 }),
    source: varchar('source', { length: 20 }).$type<ContentVerificationSource>().notNull(),
    status: varchar('status', { length: 20 }).$type<ContentVerificationStatus>().notNull(),
    expectedTitle: varchar('expected_title', { length: 500 }).notNull(),
    expectedAuthors: jsonb('expected_authors').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    detectedTitle: varchar('detected_title', { length: 500 }),
    detectedAuthor: varchar('detected_author', { length: 500 }),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
    evidence: jsonb('evidence').$type<ContentVerificationEvidence[]>().notNull().default(sql`'[]'::jsonb`),
    explanation: text('explanation'),
    reviewStatus: varchar('review_status', { length: 30 }).$type<ContentVerificationReviewStatus>(),
    reviewNote: text('review_note'),
    reviewedBy: integer('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    model: varchar('model', { length: 200 }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('book_content_verifications_book_file_uidx').on(t.bookFileId),
    index('book_content_verifications_status_idx').on(t.status),
    index('book_content_verifications_review_status_idx').on(t.reviewStatus),
    check('book_content_verifications_source_chk', sql`${t.source} in ('ebook', 'audiobook')`),
    check('book_content_verifications_status_chk', sql`${t.status} in ('match', 'mismatch', 'inconclusive', 'error')`),
    check('book_content_verifications_review_status_chk', sql`${t.reviewStatus} is null or ${t.reviewStatus} in ('confirmed_mismatch', 'false_positive', 'needs_recheck')`),
    check('book_content_verifications_confidence_chk', sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`),
  ],
);
