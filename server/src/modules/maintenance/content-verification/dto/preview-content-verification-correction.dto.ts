import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export const CONTENT_VERIFICATION_CORRECTION_TARGETS = ['existing_book', 'new_book'] as const;

export class PreviewContentVerificationCorrectionDto {
  @IsIn(CONTENT_VERIFICATION_CORRECTION_TARGETS)
  targetType!: (typeof CONTENT_VERIFICATION_CORRECTION_TARGETS)[number];

  @IsOptional()
  @IsInt()
  @Min(1)
  targetBookId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  author?: string;
}
