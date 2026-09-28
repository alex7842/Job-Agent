import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Normalise the handle the same way the shared zod contract does. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Password rules are deliberately looser than RegisterDto's: a too-short guess
 * must be answered with "incorrect email or password", not a validation error
 * that would confirm the format of the stored password.
 *
 * RegisterDto does not extend LoginDto, because tightening an inherited
 * decorated property in a subclass is not expressible in class-validator.
 */
export class LoginDto {
  @Transform(normalizeEmail) @IsEmail() @MaxLength(255) email: string;
  @IsString() @MaxLength(200) password: string;
}

export class RegisterDto {
  @Transform(normalizeEmail) @IsEmail() @MaxLength(255) email: string;
  @IsString() @MinLength(8) @MaxLength(200) password: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
}

export class RefreshDto {
  @IsString() @MinLength(1) refreshToken: string;
}
