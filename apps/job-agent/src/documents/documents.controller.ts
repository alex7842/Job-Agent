import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  CreateDocumentResult,
  DocumentRecord,
  IngestDocumentsResult,
} from '@job-agent/shared';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { DocumentsService } from './documents.service.js';

/** Document catalog management. Reads and lifecycle only; uploads are separate. */
@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@CurrentUser() user: AuthPrincipal): Promise<DocumentRecord[]> {
    return this.documents.list(user);
  }

  @Post()
  create(
    @CurrentUser() user: AuthPrincipal,
    @Body() dto: CreateDocumentDto,
  ): Promise<CreateDocumentResult> {
    return this.documents.create(user, dto);
  }

  /** Manual retry after a failed or stale index. */
  @Post(':id/reindex')
  reindex(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IngestDocumentsResult> {
    return this.documents.reindex(user, id);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.documents.remove(user, id);
    return { deleted: true };
  }
}
