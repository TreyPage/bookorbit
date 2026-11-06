import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export class CleanupEmptyBookFolderDto {
  @IsInt()
  @Min(1)
  libraryId!: number;

  @IsString()
  @MaxLength(4096)
  path!: string;
}
