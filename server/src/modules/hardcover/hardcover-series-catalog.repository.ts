import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { HardcoverSeriesCatalogCacheRow, NewHardcoverSeriesCatalogCacheRow } from '../../db/schema/hardcover-series-catalog';

@Injectable()
export class HardcoverSeriesCatalogRepository {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  async findByNormalizedName(normalizedName: string): Promise<HardcoverSeriesCatalogCacheRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.hardcoverSeriesCatalogCache)
      .where(eq(schema.hardcoverSeriesCatalogCache.normalizedName, normalizedName))
      .limit(1);
    return row ?? null;
  }

  async upsert(cache: NewHardcoverSeriesCatalogCacheRow): Promise<void> {
    await this.db
      .insert(schema.hardcoverSeriesCatalogCache)
      .values(cache)
      .onConflictDoUpdate({
        target: schema.hardcoverSeriesCatalogCache.normalizedName,
        set: {
          seriesName: cache.seriesName,
          books: cache.books,
          catalogFound: cache.catalogFound,
          expectedBookCount: cache.expectedBookCount,
          fetchedAt: cache.fetchedAt,
        },
      });
  }
}
