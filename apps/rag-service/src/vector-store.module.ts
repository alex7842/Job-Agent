import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryVectorStore } from './adapters/memory.vector-store.js';
import { PineconeVectorStore } from './adapters/pinecone.vector-store.js';
import { VECTOR_STORE } from './ports.js';
import type { VectorStore } from './ports.js';

@Global()
@Module({
  providers: [
    {
      provide: VECTOR_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): VectorStore => {
        const choice = (
          config.get<string>('VECTOR_STORE') ??
          (config.get<string>('PINECONE_API_KEY') ? 'pinecone' : 'memory')
        ).toLowerCase();
        switch (choice) {
          case 'pinecone':
            return new PineconeVectorStore(config);
          case 'memory':
            return new MemoryVectorStore();
          default:
            throw new Error(`Unknown VECTOR_STORE "${choice}". Use one of: pinecone, memory.`);
        }
      },
    },
  ],
  exports: [VECTOR_STORE],
})
export class VectorStoreModule {}
