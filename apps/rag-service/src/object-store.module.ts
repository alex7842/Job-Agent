import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalObjectStore } from './adapters/local.object-store.js';
import { S3ObjectStore } from './adapters/s3.object-store.js';
import { OBJECT_STORE } from './ports.js';
import type { ObjectStore } from './ports.js';

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ObjectStore => {
        const choice = (
          config.get<string>('OBJECT_STORE') ?? (config.get<string>('S3_BUCKET') ? 's3' : 'local')
        ).toLowerCase();
        switch (choice) {
          case 's3':
            return new S3ObjectStore(config);
          case 'local':
            return new LocalObjectStore(config);
          default:
            throw new Error(`Unknown OBJECT_STORE "${choice}". Use one of: s3, local.`);
        }
      },
    },
  ],
  exports: [OBJECT_STORE],
})
export class ObjectStoreModule {}
