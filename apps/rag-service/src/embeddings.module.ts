import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpEmbeddingModel, resolveProvider } from '@job-agent/ai';
import { OfflineEmbedding } from './adapters/offline.embedding.js';
import { EMBEDDING_PROVIDER } from './ports.js';
import type { EmbeddingProvider } from './ports.js';

/**
 * The provider is chosen here and nowhere else. Everything else in the service
 * asks for `EMBEDDING_PROVIDER` and works against the port, so adding or
 * swapping a provider is a change to this factory plus one line of `.env` —
 * not a change to the ingestion pipeline.
 *
 * `offline` is not a network provider but a deterministic local fallback, so it
 * is resolved here rather than in the package: it exists to keep `pnpm dev` and
 * the tests working with no credentials at all, and the service reports itself
 * degraded while it is in use.
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
          configuredProvider(config) ??
          'offline'
        )
          .trim()
          .toLowerCase();

        if (choice === 'offline') {
          return new OfflineEmbedding(Number(config.get<string>('EMBEDDING_DIMENSIONS')) || 384);
        }

        // The credential must come from the env vars *this* provider declares.
        // Picking "whichever key happens to be set" would hand an OpenRouter key
        // to Mistral and produce a baffling 401 instead of a config error.
        const descriptor = resolveProvider(choice);
        const apiKey =
          descriptor.apiKeyEnv.map((name) => config.get<string>(name)).find(Boolean) ?? '';

        const model = new HttpEmbeddingModel({
          descriptor,
          apiKey,
          model: config.get<string>('EMBEDDING_MODEL'),
          baseUrl: config.get<string>('AI_BASE_URL'),
          // Left undefined when unset so the provider's own default width wins;
          // EMBEDDING_DIMENSIONS is only an override, never a second source of
          // truth that can silently disagree with the model.
          ...(config.get<string>('EMBEDDING_DIMENSIONS')
            ? { dimensions: Number(config.get<string>('EMBEDDING_DIMENSIONS')) }
            : {}),
        });

        // Fail at boot rather than at the first write: a width mismatch between
        // the model and the index is otherwise a confusing runtime rejection.
        const indexDimensions = Number(config.get<string>('PINECONE_DIMENSIONS')) || 0;
        if (indexDimensions && model.dimensions !== indexDimensions) {
          throw new Error(
            `${model.provider} ${model.model} produces ${model.dimensions}-d vectors but ` +
              `PINECONE_DIMENSIONS is ${indexDimensions}. Vectors of different widths cannot share ` +
              `an index: set PINECONE_DIMENSIONS=${model.dimensions} and re-create the index, or ` +
              `choose a model that already matches.`,
          );
        }
        return model;
      },
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingsModule {}

/**
 * Which credential is present decides which provider can be assumed, for the
 * case where EMBEDDING_PROVIDER is not set explicitly. The order matches the
 * preference below and the reasoning is commented in the README: a provider is
 * only assumed when the environment actually supports it.
 */
function configuredProvider(config: ConfigService): string | undefined {
  if (config.get<string>('OPENROUTER_API_KEY')) return 'openrouter';
  if (config.get<string>('MISTRAL_API_KEY')) return 'mistral';
  return undefined;
}
