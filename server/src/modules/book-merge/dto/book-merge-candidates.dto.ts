import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class BookMergeCandidatesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  libraryId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(70)
  @Max(100)
  similarityPercent?: number;

  @ValidateIf((dto: BookMergeCandidatesDto) => dto.cursorBookIdA !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cursorBookIdA?: number;

  @ValidateIf((dto: BookMergeCandidatesDto) => dto.cursorBookIdB !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cursorBookIdB?: number;
}
