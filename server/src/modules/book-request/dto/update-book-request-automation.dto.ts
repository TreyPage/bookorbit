import { IsBoolean, IsOptional } from 'class-validator';

/** Partial update: callers may change either request-scoped automation control independently. */
export class UpdateBookRequestAutomationDto {
  @IsOptional()
  @IsBoolean()
  automaticRetryPaused?: boolean;

  @IsOptional()
  @IsBoolean()
  seedCleanupProtected?: boolean;
}
