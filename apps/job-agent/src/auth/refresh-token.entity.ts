import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per issued refresh token, so a session can actually be revoked
 * (logout) instead of living until the JWT expires. Only the SHA-256 of the
 * token is stored, so a database leak does not hand over usable sessions.
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'uuid' }) userId: string;

  /** hex sha256 of the refresh JWT — unique, so lookup is a single index hit. */
  @Column({ type: 'varchar', length: 64, unique: true }) tokenHash: string;

  @Column({ type: 'timestamptz' }) expiresAt: Date;

  /** Set on logout, and on rotation (the old token is replaced by a new one). */
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;

  @CreateDateColumn() createdAt: Date;
}
