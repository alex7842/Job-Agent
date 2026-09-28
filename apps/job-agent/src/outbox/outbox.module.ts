import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KafkaModule } from '../kafka/kafka.module.js';
import { OutboxEvent } from './entities/outbox-event.entity.js';
import { OutboxRelayService } from './outbox-relay.service.js';
import { OutboxService } from './outbox.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), KafkaModule],
  providers: [OutboxService, OutboxRelayService],
  exports: [OutboxService],
})
export class OutboxModule {}
