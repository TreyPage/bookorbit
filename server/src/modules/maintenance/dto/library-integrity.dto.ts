import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Min, Max, IsString, MaxLength } from 'class-validator';

export class ListLibraryIntegrityDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(64)
  snapshotId?: string;
}

export class DeleteDuplicateFormatFileDto {
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  fileId!: number;
}
