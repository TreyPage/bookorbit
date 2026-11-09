import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListContentVerificationDto {
  @IsOptional()
  @IsIn(['all', 'needs_review', 'reviewed', 'mismatch'])
  filter: 'all' | 'needs_review' | 'reviewed' | 'mismatch' = 'all';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}
