import { Module } from '@nestjs/common';

import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverQueueService } from './hardcover-queue.service';
import { HardcoverRepository } from './hardcover.repository';
import { HardcoverSettingsService } from './hardcover-settings.service';
import { HardcoverSeriesCatalogService } from './hardcover-series-catalog.service';

@Module({
  providers: [HardcoverQueueService, HardcoverClientService, HardcoverRepository, HardcoverSettingsService, HardcoverSeriesCatalogService],
  exports: [HardcoverQueueService, HardcoverClientService, HardcoverRepository, HardcoverSettingsService, HardcoverSeriesCatalogService],
})
export class HardcoverSettingsModule {}
