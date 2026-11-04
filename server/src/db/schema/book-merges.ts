import { sql } from 'drizzle-orm';
import { index, integer, pgTable, serial, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { timestamptz } from './columns';
import { books } from './books';
import { libraryFolders } from './libraries';

export const bookMergeSources = pgTable(
  'book_merge_sources',
  {
    id: serial('id').primaryKey(),
    libraryFolderId: integer('library_folder_id')
      .notNull()
      .references(() => libraryFolders.id, { onDelete: 'cascade' }),
    folderPath: varchar('folder_path', { length: 4096 }).notNull(),
    targetBookId: integer('target_book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at')
      .default(sql`now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex('book_merge_sources_folder_path_uidx').on(t.libraryFolderId, t.folderPath),
    index('book_merge_sources_target_book_idx').on(t.targetBookId),
  ],
);
