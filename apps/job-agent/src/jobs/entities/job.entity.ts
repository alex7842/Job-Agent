import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { JobStatus } from '@job-agent/shared';

@Entity('jobs')
@Unique('uq_jobs_profile_dedupe', ['profileId', 'dedupeHash'])
@Index('idx_jobs_profile_status_score', ['profileId', 'status', 'matchScore'])
// Supports the "sort by semantic" listing, which is a profile-scoped scan.
@Index('idx_jobs_profile_semantic', ['profileId', 'semanticScore'])
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

  // --- semantic (vector) match ---
  // Deliberately separate from matchScore above: one is the LLM's 0-100 verdict
  // on whether a human should apply, the other is raw 0-1 similarity to the
  // candidate's uploaded documents. A single blended number would hide exactly
  // the disagreement between them that makes the two worth having.
  // 'real' rather than TypeORM's 'float', which maps to double precision in
  // Postgres: it would silently disagree with the migration's column type and
  // `synchronize` would want to rewrite it. A similarity in 0..1 does not need
  // more precision than float4.
  @Column({ type: 'real', nullable: true }) semanticScore: number | null;
  @Column({ type: 'text', nullable: true }) semanticSnippet: string | null;
  @Column({ type: 'int', nullable: true }) semanticRank: number | null;
  @Column({ type: 'timestamptz', nullable: true }) semanticAt: Date | null;

  @Column({ type: 'enum', enum: JobStatus, default: JobStatus.NEW }) status: JobStatus;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
