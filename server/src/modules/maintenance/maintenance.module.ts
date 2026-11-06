import { Module } from '@nestjs/common';

import { BookModule } from '../book/book.module';
import { BookCoverStoreModule } from '../book-cover-store/book-cover-store.module';
import { ReadingAttemptEventsModule } from '../user-book-status/reading-attempt-events.module';
import { LibraryModule } from '../library/library.module';
import { CoverSweepStore } from './cover-sweep.store';
import { MissingResourcesController } from './missing-resources.controller';
import { LibraryIntegrityController } from './library-integrity.controller';
import { MissingResourcesRepository } from './missing-resources.repository';
import { MissingResourcesService } from './missing-resources.service';
import { LibraryIntegrityRepository } from './library-integrity.repository';
import { LibraryIntegrityService } from './library-integrity.service';

@Module({
  imports: [BookModule, BookCoverStoreModule, LibraryModule, ReadingAttemptEventsModule],
  controllers: [MissingResourcesController, LibraryIntegrityController],
  providers: [MissingResourcesService, MissingResourcesRepository, CoverSweepStore, LibraryIntegrityRepository, LibraryIntegrityService],
})
export class MaintenanceModule {}
