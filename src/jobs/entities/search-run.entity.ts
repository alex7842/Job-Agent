import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum RunStatus {
  RUNNING = 'running',
  COMPLETED = 'completed', // every source fetched + published to Kafka
  PARTIAL = 'partial', // some sources failed
  FAILED = 'failed', // all sources failed
}

export type RunStats = Record<string, { fetched: number; error?: string }>;

@Entity('search_runs')
export class SearchRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) profileId: string;
  @Column({ type: 'varchar' }) workflowId: string;
  @Column({ type: 'enum', enum: RunStatus, default: RunStatus.RUNNING }) status: RunStatus;
  @Column({ type: 'jsonb', default: () => `'{}'` }) stats: RunStats;
  @CreateDateColumn() startedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date | null;
}
