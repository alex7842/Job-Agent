import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { JobPreferences, ResumeData } from '@job-agent/shared';

@Entity('profiles')
export class Profile {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'varchar', length: 100, default: 'Me' }) name: string;

  /** Plain-text resume - sent to the LLM when scoring, and the semantic query. */
  @Column({ type: 'text', default: '' }) resumeText: string;

  /**
   * The uploaded file this resume came from.
   *
   * Nullable rather than required so a profile can exist with no resume at all:
   * preferences can be filled in by hand, and scoring falls back to those.
   */
  @Column({ type: 'varchar', length: 255, nullable: true }) resumeFileName: string | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) resumeMimeType: string | null;
  @Column({ type: 'bigint', nullable: true }) resumeSizeBytes: string | null;
  /** Key in the object store; the bytes never pass through the API again. */
  @Column({ type: 'text', nullable: true }) resumeObjectKey: string | null;

  /**
   * The structured resume the LLM read out of the file.
   *
   * One jsonb column rather than a set of tables: it is written in a single
   * replace, read as a whole by the profile form, and never queried by a
   * predicate. A failure here must not be able to lose the extracted text, which
   * is why resumeText is a separate column rather than derived from this.
   */
  @Column({ type: 'jsonb', nullable: true }) resumeData: ResumeData | null;

  /** When the file was last parsed. Null whenever resumeData is null. */
  @Column({ type: 'timestamptz', nullable: true }) resumeParsedAt: Date | null;
  /**
   * Why the last parse failed, stored rather than thrown so a resume that could
   * not be read is visible in the UI instead of only in the logs.
   */
  @Column({ type: 'text', nullable: true }) resumeError: string | null;

  @Column({ type: 'jsonb' }) preferences: JobPreferences;

  @Column({ type: 'boolean', default: true }) isActive: boolean;

  /**
   * Owning login. Nullable so pre-auth rows created by `DB_SYNC` in dev keep
   * working; the unique index is in the AddAuth migration, not on the entity,
   * so the HTTP layer stays the single writer of this column.
   */
  @Column({ type: 'uuid', nullable: true }) userId: string | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
