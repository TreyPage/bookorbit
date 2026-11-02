import { Module } from '@nestjs/common';

import { AchievementModule } from '../achievement/achievement.module';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { UserBookStatusModule } from '../user-book-status/user-book-status.module';
import { HardcoverAutoSyncSchedulerService } from './hardcover-auto-sync-scheduler.service';
import { HardcoverBookMatchService } from './hardcover-book-match.service';
import { HardcoverController } from './hardcover.controller';
import { HardcoverEventListener } from './hardcover-event-listener.service';
import { HardcoverImportService } from './hardcover-import.service';
import { HardcoverSettingsModule } from './hardcover-settings.module';
import { HardcoverSyncService } from './hardcover-sync.service';

@Module({
  imports: [AchievementModule, BookModule, LibraryModule, UserBookStatusModule, HardcoverSettingsModule],
  controllers: [HardcoverController],
  providers: [HardcoverBookMatchService, HardcoverSyncService, HardcoverImportService, HardcoverAutoSyncSchedulerService, HardcoverEventListener],
  exports: [HardcoverSyncService, HardcoverSettingsModule],
})
export class HardcoverModule {}
