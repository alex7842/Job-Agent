import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GEMINI_DIMENSIONS } from './adapters/gemini.embedding.js';
import { OfflineEmbedding } from './adapters/offline.embedding.js';
import { GeminiEmbedding } from './adapters/gemini.embedding.js';
import { EMBEDDING_PROVIDER } from './ports.js';
import type { EmbeddingProvider } from './ports.js';

const DIMENSIONS: Record<string, number> = {
  gemini: GEMINI_DIMENSIONS,
  offline: 384,
};

/**
 * The embedding model is the one hard constraint in this system: the Pinecone
 * index is created with a fixed dimension, and every vector written to it must
 * match. So the provider is chosen at boot and the dimension is derived from
 * that choice rather than configured twice.
 *
 * Two providers only: Gemini for real retrieval, and `offline` for tests and
 * development on machines with no key. `offline` is a hashed bag of words, so
 * it matches literally and has no notion of synonymy — which is why the
 * service reports itself degraded whenever it is the one in use.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmbeddingProvider => {
        const choice = (
          config.get<string>('EMBEDDING_PROVIDER') ??
          (config.get<string>('GEMINI_API_KEY') ? 'gemini' : 'offline')
        ).toLowerCase();

        switch (choice) {
          case 'gemini':
            return new GeminiEmbedding(config);
          case 'offline':
            return new OfflineEmbedding(DIMENSIONS.offline);
          default:
            throw new Error(
              `Unknown EMBEDDING_PROVIDER "${choice}". Use one of: ${Object.keys(DIMENSIONS).join(', ')}.`,
            );
        }
      },
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingsModule {}
