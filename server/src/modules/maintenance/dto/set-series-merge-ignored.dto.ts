import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, Min } from 'class-validator';

export class SetSeriesMergeIgnoredDto {
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  seriesId!: number;

  @IsBoolean()
  ignored!: boolean;
}
