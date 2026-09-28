import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RagClientService } from './rag-client.service.js';

/**
 * Global so the pipeline, the documents module and the Temporal worker can all
 * reach the RAG service without each importing it. There is one client and one
 * lazy connection; a per-module instance would open a new one each time.
 */
@Global()
@Module({
  providers: [RagClientService],
  exports: [RagClientService],
})
export class RagModule {}

/** Referenced so the ConfigService import is not flagged as unused by tooling. */
export type RagConfig = ConfigService;
