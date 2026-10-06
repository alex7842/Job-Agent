import {
  Body,
  Controller,
  Delete,
  Get,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_DOCUMENT_BYTES } from '@job-agent/shared';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UpdateProfileDto } from './profile.dto.js';
import { ProfileService, type ResumeUpload } from './profile.service.js';

/**
 * The shape Multer hands the interceptor. Declared here rather than taken from
 * `Express.Multer.File` so the API does not need @types/multer for one route.
 */
type UploadedFile = { originalname: string; mimetype: string; buffer: Buffer };

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthPrincipal) {
    return this.profiles.getById(user.profileId);
  }

  @Put()
  update(@CurrentUser() user: AuthPrincipal, @Body() dto: UpdateProfileDto) {
    return this.profiles.update(user.profileId, dto);
  }

  /**
   * The whole resume flow in one request: store, extract, parse, prefill.
   *
   * Multer is configured with memory storage, so the bytes arrive as a Buffer and
   * never touch this machine's disk. The declared mime type is re-checked in the
   * service against the same allowlist the extractor sniffs with, because the
   * browser's content type is a claim rather than a fact.
   */
  @Post('resume')
  @UseInterceptors(FileInterceptor('file'))
  uploadResume(
    @CurrentUser() user: AuthPrincipal,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: MAX_DOCUMENT_BYTES })],
        fileIsRequired: true,
      }),
    )
    file: UploadedFile,
  ) {
    const upload: ResumeUpload = {
      fileName: file.originalname,
      mimeType: file.mimetype,
      content: file.buffer,
    };
    return this.profiles.uploadResume(user.profileId, upload);
  }

  /**
   * A signed, expiring link to the stored file. Fetched on demand rather than
   * listed with the profile: the URL stops working, so showing a stale one would
   * be a link that fails when clicked.
   */
  @Get('resume/link')
  resumeLink(@CurrentUser() user: AuthPrincipal) {
    return this.profiles.resumeLink(user.profileId);
  }

  @Delete('resume')
  removeResume(@CurrentUser() user: AuthPrincipal) {
    return this.profiles.removeResume(user.profileId);
  }
}
