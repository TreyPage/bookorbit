import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const CONTENT_VERIFICATION_REVIEW_STATUSES = [
  'confirmed_mismatch',
  'false_positive',
  'needs_recheck',
] as const;

export class ReviewContentVerificationDto {
  @IsIn(CONTENT_VERIFICATION_REVIEW_STATUSES)
  reviewStatus!: (typeof CONTENT_VERIFICATION_REVIEW_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNote?: string;
}
