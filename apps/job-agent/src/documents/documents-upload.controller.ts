import {
  BadRequestException,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  isAllowedDocumentMime,
  type DocumentRecord,
} from '@job-agent/shared';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { DocumentsService } from './documents.service.js';

/**
 * The two ways bytes get into the object store.
 *
 * Split from the catalog controller because these are the routes that carry a
 * body, and the DTO/validation concerns are different: one accepts no body at
 * all, the other accepts raw file bytes.
 *
 * The upload route is a fallback, not the production path. With S3 configured the
 * browser PUTs to a presigned bucket URL and never touches this API; it exists
 * because a local filesystem has nothing to presign against.
 */
@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsUploadController {
  constructor(private readonly documents: DocumentsService) {}

  /** S3 mode: the browser has finished PUTting the bytes; index them now. */
  @Post(':id/complete')
  complete(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentRecord> {
    return this.documents.complete(user, id);
  }

  /** Local mode: the bytes are relayed to the RAG service, which stores them. */
  @Put(':id/content')
  async upload(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('content-type') contentType: string | undefined,
  ): Promise<DocumentRecord> {
    // express.raw() fills req.body; the rawBody option fills req.rawBody. Either
    // way it is the file's bytes, and nothing here trusts a content type the
    // client chose beyond the allowed list below.
    const body: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
    if (!body?.length) {
      throw new BadRequestException('Empty upload. Send the file as the request body.');
    }
    if (!contentType || !isAllowedDocumentMime(contentType)) {
      throw new UnsupportedMediaTypeException(
        `Send one of: ${ALLOWED_DOCUMENT_MIME_TYPES.join(', ')} (got ${contentType ?? 'nothing'}).`,
      );
    }
    // The forwarded mime type is the document's own, which was validated when
    // the upload was created, rather than whatever the browser sent here.
    return this.documents.uploadContent(user, id, body);
  }
}
