import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class PreferencesDto {
  @IsOptional() @IsArray() @IsString({ each: true }) roles?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) skills?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) locations?: string[];
  @IsOptional() @IsBoolean() remoteOnly?: boolean;
  @IsOptional() @IsInt() @Min(0) minSalary?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) excludedKeywords?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) excludedCompanies?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) greenhouseBoards?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) sources?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(30) postedWithinDays?: number;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(50000) resumeText?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @ValidateNested() @Type(() => PreferencesDto) preferences?: PreferencesDto;
}
