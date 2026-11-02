import { Module } from '@nestjs/common';

import { LibraryModule } from '../library/library.module';
import { BookMergeController } from './book-merge.controller';
import { BookMergeRepository } from './book-merge.repository';
import { BookMergeService } from './book-merge.service';

@Module({
  imports: [LibraryModule],
  controllers: [BookMergeController],
  providers: [BookMergeRepository, BookMergeService],
})
export class BookMergeModule {}
