import {
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Column,
} from 'typeorm';

/**
 * A login identity. Everything user-specific hangs off this row: the profile
 * (preferences, resume) and every job and run, all scoped by `profiles.id`.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;

  /** Lower-cased and unique; the login handle. */
  @Column({ type: 'varchar', length: 255, unique: true }) email: string;

  /** scrypt digest, never a plain password. See PasswordService. */
  @Column({ type: 'text' }) passwordHash: string;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
