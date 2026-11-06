import { Transform } from 'class-transformer';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class MergeSeriesDto {
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  targetSeriesId!: number;

  @Transform(({ value }) => Array.isArray(value) ? value.map(Number) : value)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  sourceSeriesIds!: number[];

  @IsOptional()
  @IsBoolean()
  confirmPositionConflicts = false;
}
