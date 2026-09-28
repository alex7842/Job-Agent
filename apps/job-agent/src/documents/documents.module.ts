import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KafkaModule } from '../kafka/kafka.module.js';
import { Document } from './entities/document.entity.js';
import { DocumentStatusConsumer } from './document-status.consumer.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { DocumentsUploadController } from './documents-upload.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Document]), KafkaModule],
  controllers: [DocumentsController, DocumentsUploadController, DocumentStatusConsumer],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
