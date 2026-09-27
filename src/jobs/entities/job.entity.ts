import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from 'typeorm';

export enum JobStatus {
  NEW = 'new',
  SAVED = 'saved',
  APPLIED = 'applied',
  IGNORED = 'ignored',
}

@Entity('jobs')
@Unique('uq_jobs_profile_dedupe', ['profileId', 'dedupeHash'])
@Index('idx_jobs_profile_status_score', ['profileId', 'status', 'matchScore'])
export class Job {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'uuid' }) profileId: string;
  @Column({ type: 'uuid', nullable: true }) runId: string | null;

  @Column({ type: 'varchar' }) source: string;
  @Column({ type: 'varchar' }) externalId: string;
  /** hash(profile + company + title + location) -> same job from 2 platforms is stored once */
  @Column({ type: 'varchar', length: 40 }) dedupeHash: string;

  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'varchar' }) company: string;
  @Column({ type: 'varchar', nullable: true }) location: string | null;
  @Column({ type: 'boolean', nullable: true }) remote: boolean | null;
  @Column({ type: 'varchar', nullable: true }) salaryText: string | null;
  @Column({ type: 'text', nullable: true }) description: string | null;
  /** link to the original posting on the platform */
  @Column({ type: 'text' }) applyUrl: string;
  @Column({ type: 'timestamptz', nullable: true }) postedAt: Date | null;

  // --- AI match ---
  @Column({ type: 'int', nullable: true }) matchScore: number | null;
  @Column({ type: 'text', nullable: true }) matchReason: string | null;
  @Column({ type: 'jsonb', default: () => `'[]'` }) highlights: string[];
  @Column({ type: 'jsonb', default: () => `'[]'` }) redFlags: string[];
  @Column({ type: 'timestamptz', nullable: true }) scoredAt: Date | null;
  @Column({ type: 'text', nullable: true }) scoreError: string | null;

  @Column({ type: 'enum', enum: JobStatus, default: JobStatus.NEW }) status: JobStatus;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
