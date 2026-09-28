import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import {
  DOCUMENT_STATUS,
  MAX_DOCUMENT_BYTES,
  TOPICS,
  type DocumentIndexedEvent,
  type IngestDocumentsResult,
  type PresignDocumentResponse,
} from '@job-agent/shared';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { DocumentRepository } from '../database/document.repository.js';
import { OBJECT_STORE, buildObjectKey } from '../ports.js';
import type { ObjectStore } from '../ports.js';
import { KafkaPublisherService } from '../kafka/publisher.service.js';
import { InternalGuard } from './internal.guard.js';
import { presignDocumentSchema, relayedUploadHeaders } from './internal.schemas.js';

/**
 * Upload path. The RAG service owns the object store, so it is the only thing
 * that can hand out a presigned URL — the job agent asks here and relays the
 * answer to the browser. That keeps bucket credentials and key layout in one
 * place, and keeps this service's HMAC secret on the server: the browser never
 * talks to it directly.
 */
@Controller('internal/documents')
@UseGuards(InternalGuard)
export class InternalDocumentsController {
  constructor(
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    private readonly documents: DocumentRepository,
    private readonly ingestion: IngestionService,
    private readonly publisher: KafkaPublisherService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Register the document and return where to put its bytes.
   *
   * The row is written here rather than waiting for documents.changed so that
   * local mode has something to attach the object to: the relayed upload below
   * needs the object key, and without a row there is nowhere to read it from.
   */
  @Post('presign')
  async presign(@Body() body: unknown): Promise<PresignDocumentResponse> {
    const parsed = presignDocumentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data;

    const objectKey = buildObjectKey(input.profileId, input.fileName);
    await this.documents.upsert({
      documentId: input.documentId,
      profileId: input.profileId,
      userId: input.userId,
      kind: input.kind,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      objectKey,
      isPrimary: input.isPrimary ?? false,
    });

    const expiresIn = this.presignExpiry;
    // The local store has no endpoint to presign against, so it reports its own
    // scheme and the caller relays the bytes through the API instead.
    const presigned = await this.objects.presignPut(objectKey, input.mimeType, expiresIn);
    const mode = presigned.startsWith('local://') ? 'local' : 's3';

    return {
      objectKey,
      mode,
      // Normalised to null: a `local://` key is not a URL a browser could PUT to,
      // and handing it out would invite a fetch to a non-existent host.
      uploadUrl: mode === 's3' ? presigned : null,
      expiresInSeconds: expiresIn,
      maxBytes: MAX_DOCUMENT_BYTES,
    };
  }

  /**
   * Local mode only: the browser cannot PUT to a filesystem, so the job agent
   * relays the bytes here. Indexing happens inline because the caller is
   * waiting and the answer is the document's real status.
   */
  @Put(':documentId/content')
  async putContent(
    @Req() req: RawBodyRequest<Request>,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Headers(relayedUploadHeaders.profileId) profileId: string | undefined,
    @Headers(relayedUploadHeaders.sizeBytes) declaredSize: string | undefined,
  ): Promise<IngestDocumentsResult> {
    // express.raw() fills req.body; the rawBody option fills req.rawBody. Either
    // is a Buffer, and a zero-length one is a client error rather than a document
    // that happens to contain no text.
    const body: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
    if (!body || body.length === 0) throw new BadRequestException('Empty request body');
    if (body.length > MAX_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException(`Documents are capped at ${MAX_DOCUMENT_BYTES} bytes`);
    }

    // The declared size is advisory; the bytes that actually arrived win. Trusting
    // the header would let a caller store something other than what it claimed.
    const doc = await this.documents.findById(documentId);
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);
    if (profileId && doc.profileId !== profileId) {
      // Same answer as a missing document: a caller must not be able to probe
      // for another profile's document ids.
      throw new NotFoundException(`Document ${documentId} not found`);
    }
    if (declaredSize && Number(declaredSize) !== body.length) {
      throw new BadRequestException(
        `Declared size ${declaredSize} does not match the ${body.length} bytes received`,
      );
    }

    await this.objects.put(doc.objectKey, body, doc.mimeType);
    const result = await this.ingestion.ingestDocument(doc.documentId);

    // Same report as the Kafka path, so the catalog's status does not depend on
    // which upload mode was used.
    if (result.status === DOCUMENT_STATUS.READY || result.status === DOCUMENT_STATUS.FAILED) {
      await this.publisher.emit(TOPICS.DOC_INDEXED, doc.profileId, {
        documentId: doc.documentId,
        profileId: doc.profileId,
        status: result.status,
        chunkCount: result.indexed,
        errorMessage: result.errorMessage ?? null,
      } satisfies DocumentIndexedEvent);
    }

    return result;
  }

  private get presignExpiry(): number {
    // Number(), not the generic: every env value is a string, so a `get<number>`
    // would hand a string to the S3 signer and produce a broken presign.
    const configured = Number(this.config.get<string>('RAG_PRESIGN_TTL_SECONDS'));
    return Number.isFinite(configured) && configured > 0 ? configured : 900;
  }
}
