import { Module } from '@nestjs/common';

import { AppSettingsModule } from '../app-settings/app-settings.module';

import { BookModule } from '../book/book.module';
import { BookCoverStoreModule } from '../book-cover-store/book-cover-store.module';
import { ReadingAttemptEventsModule } from '../user-book-status/reading-attempt-events.module';
import { LibraryModule } from '../library/library.module';
import { CoverSweepStore } from './cover-sweep.store';
import { LibraryIntegrityController } from './library-integrity.controller';
import { LibraryIntegrityRepository } from './library-integrity.repository';
import { LibraryIntegrityService } from './library-integrity.service';
import { LibraryIntegrityScanSchedulerService } from './library-integrity-scan-scheduler.service';
import { MissingResourcesController } from './missing-resources.controller';
import { MissingResourcesRepository } from './missing-resources.repository';
import { MissingResourcesService } from './missing-resources.service';
import { ContentVerificationAiService } from './content-verification/content-verification-ai.service';
import { AudiobookOpeningTranscriptionService } from './content-verification/audiobook-opening-transcription.service';
import { ContentVerificationController } from './content-verification/content-verification.controller';
import { ContentVerificationRepository } from './content-verification/content-verification.repository';
import { ContentVerificationService } from './content-verification/content-verification.service';
import { ContentVerificationSchedulerService } from './content-verification/content-verification-scheduler.service';

@Module({
  imports: [AppSettingsModule, BookModule, BookCoverStoreModule, LibraryModule, ReadingAttemptEventsModule],
  controllers: [MissingResourcesController, LibraryIntegrityController, ContentVerificationController],
  exports: [ContentVerificationSchedulerService],
  providers: [
    MissingResourcesService,
    ContentVerificationAiService,
    AudiobookOpeningTranscriptionService,
    ContentVerificationRepository,
    ContentVerificationService,
    ContentVerificationSchedulerService,
    MissingResourcesRepository,
    CoverSweepStore,
    LibraryIntegrityRepository,
    LibraryIntegrityService,
    LibraryIntegrityScanSchedulerService,
  ],
})
export class MaintenanceModule {}
