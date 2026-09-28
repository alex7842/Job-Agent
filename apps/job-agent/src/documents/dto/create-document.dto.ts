import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_DOCUMENT_BYTES } from '@job-agent/shared';

/**
 * The DTO mirrors the shared zod schema but as a class, because the API's
 * ValidationPipe works on classes and a zod object would not be validated at all.
 */
export class CreateDocumentDto {
  @IsString() @Matches(/\S/) fileName: string;

  @IsString() @Matches(/\S/) mimeType: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Bounded here as well as in the service, so an absurd value is rejected by the
  // pipe before it is ever compared or stored.
  @Max(MAX_DOCUMENT_BYTES)
  sizeBytes: number;

  @IsString() @Matches(/^(resume|cover_letter|other)$/) kind: 'resume' | 'cover_letter' | 'other';

  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
