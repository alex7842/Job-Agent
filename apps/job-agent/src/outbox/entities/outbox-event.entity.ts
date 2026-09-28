import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Events that have been decided but not yet handed to Kafka.
 *
 * The raw-jobs handler writes a job row and then needs to publish two events
 * for it. Publishing inside the same request as the insert is what left jobs
 * stranded: if the broker refused the second publish after the first had landed,
 * the row existed but nothing would ever score or index it, and the consumer had
 * already been told the message was handled. Recording the intent in the same
 * transaction as the row makes publication a separate, retryable step.
 */
@Entity('outbox_events')
@Index('idx_outbox_pending', ['publishedAt', 'createdAt'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'varchar' }) topic: string;

  /** Kafka key. Keeping the profile id preserves per-profile ordering. */
  @Column({ type: 'varchar' }) partitionKey: string;

  @Column({ type: 'jsonb' }) payload: unknown;

  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
  @Column({ type: 'timestamptz', nullable: true }) publishedAt: Date | null;

  @CreateDateColumn() createdAt: Date;
}
