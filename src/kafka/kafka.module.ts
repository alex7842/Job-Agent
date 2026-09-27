import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { KAFKA_CLIENT } from '../common/constants.js';
import { brokersFrom } from './kafka.config.js';
import { KafkaProducerService } from './kafka-producer.service.js';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: KAFKA_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: { clientId: 'jobs-producer', brokers: brokersFrom(config) },
            producerOnlyMode: true,
          },
        }),
      },
    ]),
  ],
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
