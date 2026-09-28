import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { KAFKA_CLIENT } from '@job-agent/shared';

@Injectable()
export class KafkaProducerService implements OnModuleDestroy {
  private connecting?: Promise<unknown>;

  constructor(@Inject(KAFKA_CLIENT) private readonly client: ClientKafka) {}

  // lazy connect -> no dependency on lifecycle order (API consumers / Temporal activities)
  private ready() {
    this.connecting ??= this.client.connect();
    return this.connecting;
  }

  async emit(topic: string, key: string, value: unknown) {
    await this.ready();
    await lastValueFrom(this.client.emit(topic, { key, value }));
  }

  async emitMany(topic: string, items: { key: string; value: unknown }[]) {
    for (let i = 0; i < items.length; i += 100) {
      await Promise.all(items.slice(i, i + 100).map((m) => this.emit(topic, m.key, m.value)));
    }
  }

  async onModuleDestroy() {
    if (this.connecting) await this.client.close();
  }
}
