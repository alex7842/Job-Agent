import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { MAX_DOCUMENT_BYTES, documentMimeFor } from '@job-agent/shared';
import { OBJECT_STORE } from '../ports.js';
import type { ObjectStore } from '../ports.js';
import { TextExtractor } from '../ingestion/text-extractor.service.js';
import { InternalGuard } from './internal.guard.js';
import { relayedUploadHeaders } from './internal.schemas.js';

/**
 * Resumes: store the bytes and hand back the text, synchronously.
 *
 * There is no catalog row and no Kafka message here. A resume belongs to exactly
 * one profile, so there is nothing to reconcile later and nothing for a consumer
 * to do that the caller could not do inline; the caller is the browser, waiting
 * to be told whether its profile was filled in. The job agent extracts the
 * structure with the LLM on top of the text returned here.
 *
 * Storing and extracting in one call also means the file is never orphaned: if
 * extraction finds nothing the object is still written, so the user can see which
 * file they uploaded and retry, rather than being left with bytes and no record.
 */
/**
 * What the extractor found, as the object's Content-Type.
 *
 * The browser's declared type is a claim and is not forwarded: it decides nothing
 * here. The sniffed type is what gets stored, so a PDF is served as a PDF and
 * renders in the browser instead of downloading as an opaque blob.
 */
const MIME_FOR_DETECTED: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain',
};

@Controller('internal/resumes')
@UseGuards(InternalGuard)
export class InternalResumesController {
  private readonly presignTtl: number;

  constructor(
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    private readonly extractor: TextExtractor,
    config: ConfigService,
  ) {
    this.presignTtl = Number(config.get<string>('RAG_PRESIGN_TTL_SECONDS')) || 900;
  }

  @Post()
  async upload(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-rag-file-name') fileName: string | undefined,
    @Headers(relayedUploadHeaders.profileId) profileId: string | undefined,
  ): Promise<{ objectKey: string; text: string; detected: string; truncated: boolean }> {
    const body: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
    if (!body || body.length === 0) throw new BadRequestException('Empty request body');
    if (body.length > MAX_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException(`Resumes are capped at ${MAX_DOCUMENT_BYTES} bytes`);
    }
    if (!profileId) throw new BadRequestException('x-rag-profile-id is required');

    const name = decodeURIComponent(fileName ?? 'resume.txt');
    const key = `resumes/${profileId}/${randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // Extract before storing so the object can be written with the type that was
    // actually found. The write still happens for a file we cannot read: the
    // bytes the user uploaded then exist and can be replaced, rather than
    // vanishing because the text layer was missing.
    const extracted = await this.extractor.extract(body, name);
    await this.objects.put(
      key,
      body,
      MIME_FOR_DETECTED[extracted.detected] ?? 'application/octet-stream',
    );

    if (!extracted.text) {
      throw new BadRequestException(
        'No text could be read from that file. It is probably a scan or an image; ' +
          'upload a text-based PDF or DOCX.',
      );
    }

    return {
      objectKey: key,
      text: extracted.text,
      detected: extracted.detected,
      truncated: extracted.truncated,
    };
  }

  /**
   * A short-lived signed URL for a stored resume, so viewing it does not pull the
   * bytes through the API. Only the key is signed, never the bytes: the caller
   * already has them if it wanted them.
   *
   * The key must sit under this profile's own prefix. The internal secret is
   * shared by every route on both sides, so without this check a caller holding
   * it could sign a URL for any key in the bucket, including another profile's.
   */
  @Get('link')
  async link(
    @Headers(relayedUploadHeaders.profileId) profileId: string | undefined,
    @Query('key') key: string | undefined,
    @Query('fileName') fileName: string | undefined,
  ): Promise<{ url: string; expiresInSeconds: number; store: string }> {
    if (!profileId) throw new BadRequestException('x-rag-profile-id is required');
    if (!key) throw new BadRequestException('key is required');
    if (key.includes('..')) throw new BadRequestException('key must not contain ..');

    const prefix = `resumes/${profileId}/`;
    if (!key.startsWith(prefix)) {
      throw new BadRequestException(`key must start with ${prefix}`);
    }

    return {
      url: await this.objects.presignGet(key, this.presignTtl, {
        fileName,
        // Signed into the URL, so the served type follows the file name rather
        // than whatever type the object happened to be written with.
        contentType: fileName ? (documentMimeFor(fileName) ?? undefined) : undefined,
      }),
      expiresInSeconds: this.presignTtl,
      store: this.objects.name,
    };
  }
}
