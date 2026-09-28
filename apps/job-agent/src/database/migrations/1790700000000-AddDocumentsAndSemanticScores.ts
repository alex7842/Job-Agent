import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Document catalog and semantic scoring.
 *
 * The documents table is the job agent's own record of what a user uploaded. The
 * bytes live in the object store and the vectors in the RAG service, both owned
 * elsewhere; this table is only what the job agent needs in order to authorize,
 * list, and know which file is the primary resume. It deliberately holds no
 * extracted text — a resume would then exist in two databases and drift.
 *
 * The semantic columns are kept apart from the LLM's `matchScore` on purpose:
 * `matchScore` is a 0-100 verdict on whether to apply, `semanticScore` is raw
 * 0-1 vector similarity. They are stored, filtered and sorted independently.
 */
export class AddDocumentsAndSemanticScores1790700000000 implements MigrationInterface {
  name = 'AddDocumentsAndSemanticScores1790700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "document_kind" AS ENUM ('resume', 'cover_letter', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "document_status" AS ENUM ('awaiting_upload', 'indexing', 'ready', 'failed', 'deleted')`,
    );

    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "profileId" uuid NOT NULL,
        "kind" "document_kind" NOT NULL,
        "fileName" character varying NOT NULL,
        "mimeType" character varying NOT NULL,
        "sizeBytes" bigint NOT NULL,
        "objectKey" character varying NOT NULL,
        "status" "document_status" NOT NULL DEFAULT 'awaiting_upload',
        "isPrimary" boolean NOT NULL DEFAULT false,
        "chunkCount" integer NOT NULL DEFAULT 0,
        "errorMessage" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_documents_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_documents_profile_created" ON "documents" ("profileId", "createdAt")`,
    );

    // At most one primary resume per profile. A partial unique index is the only
    // way to express that in the database: application-level "clear the others"
    // would race with two concurrent uploads and leave two primaries, making the
    // search query source ambiguous.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_documents_primary" ON "documents" ("profileId")
      WHERE "isPrimary" = true
    `);

    await queryRunner.query(`ALTER TABLE "jobs" ADD "semanticScore" real`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "semanticSnippet" text`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "semanticRank" integer`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "semanticAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `CREATE INDEX "idx_jobs_profile_semantic" ON "jobs" ("profileId", "semanticScore")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_jobs_profile_semantic"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "semanticAt"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "semanticRank"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "semanticSnippet"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "semanticScore"`);
    await queryRunner.query(`DROP INDEX "uq_documents_primary"`);
    await queryRunner.query(`DROP INDEX "idx_documents_profile_created"`);
    await queryRunner.query(`DROP TABLE "documents"`);
    await queryRunner.query(`DROP TYPE "document_status"`);
    await queryRunner.query(`DROP TYPE "document_kind"`);
  }
}
