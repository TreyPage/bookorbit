import { IsBoolean, ValidateIf } from 'class-validator';

/** Partial update: callers may change either request-scoped automation control independently. */
export class UpdateBookRequestAutomationDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  automaticRetryPaused?: boolean;

  @IsOptional()
  @IsBoolean()
  seedCleanupProtected?: boolean;
}
