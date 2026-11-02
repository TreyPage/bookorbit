import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsInt, IsPositive } from 'class-validator';

export class MergeBooksDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @Type(() => Number)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  sourceBookIds!: number[];

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  targetBookId!: number;
}
