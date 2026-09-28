import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { RunStatus, type RunStats } from '@job-agent/shared';

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
