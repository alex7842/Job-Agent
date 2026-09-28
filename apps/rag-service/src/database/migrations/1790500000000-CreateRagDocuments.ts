import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the RAG service's document index table.
 *
 * Note this is a separate table from anything the job agent owns: services
 * sharing a database still must not share table ownership, otherwise a
 * `migration:revert` in one process drops the other's data.
 *
 * The enum types are created here under fixed names and the entity matches them
 * with `enumName`. TypeORM's default would prefix them with the *database* name
 * (`task_app_rag_documents_kind_enum`), which makes the SQL here silently depend
 * on DB_NAME and breaks the migration on every database that is not the one it
 * was written against.
 */
export class CreateRagDocuments1790500000000 implements MigrationInterface {
  name = 'CreateRagDocuments1790500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "rag_document_kind" AS ENUM ('resume', 'cover_letter', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "rag_document_status" AS ENUM ('uploaded', 'indexing', 'ready', 'failed', 'deleted')`,
    );

    await queryRunner.query(`
      CREATE TABLE "rag_documents" (
        "documentId" uuid NOT NULL,
        "profileId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "kind" "rag_document_kind" NOT NULL,
        "fileName" character varying NOT NULL,
        "mimeType" character varying NOT NULL,
        "sizeBytes" bigint NOT NULL,
        "objectKey" character varying NOT NULL,
        "status" "rag_document_status" NOT NULL DEFAULT 'uploaded',
        "isPrimary" boolean NOT NULL DEFAULT false,
        "chunkCount" integer NOT NULL DEFAULT 0,
        "errorMessage" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_rag_documents_documentId" PRIMARY KEY ("documentId")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_rag_documents_profile_created" ON "rag_documents" ("profileId", "createdAt")`,
    );

    // Partial index for the hot path: "the primary, ready document of a
    // profile". Partial keeps it tiny, since most rows are not that.
    await queryRunner.query(`
      CREATE INDEX "idx_rag_documents_primary" ON "rag_documents" ("profileId")
      WHERE "isPrimary" = true AND "status" = 'ready'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_rag_documents_primary"`);
    await queryRunner.query(`DROP INDEX "idx_rag_documents_profile_created"`);
    await queryRunner.query(`DROP TABLE "rag_documents"`);
    await queryRunner.query(`DROP TYPE "rag_document_status"`);
    await queryRunner.query(`DROP TYPE "rag_document_kind"`);
  }
}
