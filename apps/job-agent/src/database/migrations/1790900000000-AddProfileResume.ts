import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Resume owned by the profile.
 *
 * Replaces the separate documents catalog: a profile has at most one resume, so
 * the file, the extracted text and the structured parse all live on the profile
 * row instead of in a table joined back by profileId.
 */
export class AddProfileResume1790900000000 implements MigrationInterface {
  name = 'AddProfileResume1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "profiles" ADD "resumeFileName" varchar(255)`);
    await queryRunner.query(`ALTER TABLE "profiles" ADD "resumeMimeType" varchar(120)`);
    // bigint: TypeORM maps `bigint` to string, which is what keeps a byte count
    // from silently becoming a JS number above 2^53 on a pathological upload.
    await queryRunner.query(`ALTER TABLE "profiles" ADD "resumeSizeBytes" bigint`);
    await queryRunner.query(`ALTER TABLE "profiles" ADD "resumeObjectKey" text`);
    await queryRunner.query(`ALTER TABLE "profiles" ADD "resumeData" jsonb`);
    await queryRunner.query(`ALTER TABLE "profiles" ADD "resumeParsedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "profiles" ADD "resumeError" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "resumeError"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "resumeParsedAt"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "resumeData"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "resumeObjectKey"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "resumeSizeBytes"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "resumeMimeType"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "resumeFileName"`);
  }
}
