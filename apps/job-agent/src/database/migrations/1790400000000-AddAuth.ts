import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuth1790400000000 implements MigrationInterface {
  name = 'AddAuth1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(255) NOT NULL, "passwordHash" text NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "uq_users_email" UNIQUE ("email"), CONSTRAINT "PK_users" PRIMARY KEY ("id"))`,
    );

    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL, "userId" uuid NOT NULL, "tokenHash" character varying(64) NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "revokedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "uq_refresh_tokens_hash" UNIQUE ("tokenHash"), CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"))`,
    );
    // The revoke-all-on-reuse lookup is by userId + revokedAt.
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_user_revoked" ON "refresh_tokens" ("userId", "revokedAt") `,
    );

    // Nullable: dev databases created by `synchronize` before this migration have
    // an unowned profile, and dropping it would take its jobs and runs with it.
    await queryRunner.query(`ALTER TABLE "profiles" ADD "userId" uuid`);
    // One profile per user, so /profile is unambiguous. Postgres allows repeated
    // NULLs, which is exactly what the legacy unowned rows need.
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_profiles_user" ON "profiles" ("userId") `);
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD CONSTRAINT "fk_profiles_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "profiles" DROP CONSTRAINT "fk_profiles_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_profiles_user"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "userId"`);
    await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_user_revoked"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
