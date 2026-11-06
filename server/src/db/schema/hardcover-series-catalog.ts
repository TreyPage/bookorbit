import { boolean, jsonb, pgTable, timestamp, varchar, integer } from 'drizzle-orm/pg-core';
import type { MissingSeriesBook } from '@bookorbit/types';

export const hardcoverSeriesCatalogCache = pgTable('hardcover_series_catalog_cache', {
  normalizedName: varchar('normalized_name', { length: 500 }).primaryKey(),
  seriesName: varchar('series_name', { length: 500 }).notNull(),
  books: jsonb('books').$type<MissingSeriesBook[]>().notNull(),
  catalogFound: boolean('catalog_found').notNull(),
  expectedBookCount: integer('expected_book_count'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
});

export type HardcoverSeriesCatalogCacheRow = typeof hardcoverSeriesCatalogCache.$inferSelect;
export type NewHardcoverSeriesCatalogCacheRow = typeof hardcoverSeriesCatalogCache.$inferInsert;
