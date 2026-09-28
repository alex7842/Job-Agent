import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { JobPreferences } from '@job-agent/shared';

@Entity('profiles')
export class Profile {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'varchar', length: 100, default: 'Me' }) name: string;

  /** Plain-text resume - sent to the LLM when scoring */
  @Column({ type: 'text', default: '' }) resumeText: string;

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
