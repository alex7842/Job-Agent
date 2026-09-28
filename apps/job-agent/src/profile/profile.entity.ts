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

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
